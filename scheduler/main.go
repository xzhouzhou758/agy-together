// agy-scheduler: CLIProxyAPI scheduler plugin for AGY Together.
//
// The portal backend puts the list of auth IDs a request may use into an
// internal request header (default "X-Agy-Allow: id1,id2"). This plugin only
// ever picks among scheduler candidates that appear in that list. When no
// allowed candidate is available, or the header is missing / malformed, it
// returns Reject so CPA never falls back to its built-in scheduler.
//
// Session stickiness (always inside the allowed list): the portal also sends
// "X-Agy-Session: <opaque key>" and "X-Agy-Mode: cache|balance|performance".
//   - performance (or no session): least-recently-used allowed candidate.
//   - balance: keep the bound auth while it is an allowed candidate; otherwise
//     rebind to the LRU allowed candidate.
//   - cache: keep the bound auth while it is an allowed candidate. When it is
//     missing (cooling down / already tried / held back by the portal), serve from a
//     sticky stand-in but keep the binding, so the session returns to its
//     prompt cache once the account is back. After cacheGrace without the bound
//     account (the prompt cache is gone by then) the stand-in becomes the binding.
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	void* call;
	void* free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

const (
	pluginName        = "agy-scheduler"
	pluginVersion     = "0.2.0"
	defaultHeaderName = "X-Agy-Allow"
	maxAllowedIDs     = 512
	sessionHeader     = "X-Agy-Session"
	modeHeader        = "X-Agy-Mode"
	ttlHeader         = "X-Agy-Session-Ttl"
	defaultTTL        = time.Hour
	defaultMaxSession = 20000
	maxSessionKeyLen  = 200
	cacheGrace        = 5 * time.Minute
)

const (
	modePerformance = "performance"
	modeBalance     = "balance"
	modeCache       = "cache"
)

type pluginConfig struct {
	// Header carries the comma-separated allowed auth IDs.
	Header string `yaml:"header"`
	// AllowMissingHeader: when true and the header is absent, the pick is left
	// to CPA's built-in scheduler. Default false = reject (fail closed).
	AllowMissingHeader bool `yaml:"allow_missing_header"`
	// LogPicks writes one line per decision to stderr (docker logs).
	LogPicks *bool `yaml:"log_picks"`
	// SessionTTL is the default binding lifetime ("1h"); X-Agy-Session-Ttl (seconds) overrides it per request.
	SessionTTL string `yaml:"session_ttl"`
	// MaxSessions bounds the binding table (default 20000).
	MaxSessions int `yaml:"max_sessions"`
}

func (c pluginConfig) sessionTTL() time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(c.SessionTTL)); err == nil && d > 0 {
		return d
	}
	return defaultTTL
}

func (c pluginConfig) maxSessions() int {
	if c.MaxSessions > 0 {
		return c.MaxSessions
	}
	return defaultMaxSession
}

func (c pluginConfig) headerName() string {
	if h := strings.TrimSpace(c.Header); h != "" {
		return h
	}
	return defaultHeaderName
}

func (c pluginConfig) logPicks() bool {
	return c.LogPicks == nil || *c.LogPicks
}

var (
	currentConfig atomic.Value // pluginConfig
	lruMu         sync.Mutex
	lastPicked    = map[string]int64{}    // auth ID -> unix nano of last pick
	bindings      = map[string]*binding{} // session|model -> binding (guarded by lruMu)
	pickSeq       atomic.Uint64
	nowFunc       = time.Now
)

type binding struct {
	primary   string
	primaryAt int64 // last time primary served (unix nano)
	standIn   string
	expires   int64
}

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type lifecycleRequest struct {
	ConfigYAML []byte `json:"config_yaml"`
}

type registration struct {
	SchemaVersion uint32                 `json:"schema_version"`
	Metadata      pluginapi.Metadata     `json:"metadata"`
	Capabilities  registrationCapability `json:"capabilities"`
}

type registrationCapability struct {
	Scheduler bool `json:"scheduler"`
	// Receive candidates from every priority tier, so allowed accounts in a
	// lower tier are not hidden from the plugin.
	SchedulerAcrossPriorities bool `json:"scheduler_across_priorities"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	plugin.abi_version = C.uint32_t(pluginabi.ABIVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) (rc C.int) {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	// A Go panic must never cross the C boundary. Turning it into an error
	// envelope makes CPA fail the pick (closed), never fall back.
	defer func() {
		if r := recover(); r != nil {
			writeResponse(response, errorEnvelope("plugin_panic", fmt.Sprint(r)))
			rc = 1
		}
	}()
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	var requestBytes []byte
	if request != nil && requestLen > 0 {
		requestBytes = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, errHandle := handleMethod(C.GoString(method), requestBytes)
	if errHandle != nil {
		writeResponse(response, errorEnvelope("plugin_error", errHandle.Error()))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

func handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		if err := configure(request); err != nil {
			return nil, err
		}
		return okEnvelope(pluginRegistration())
	case pluginabi.MethodSchedulerPick:
		return pickAuth(request)
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

func configure(raw []byte) error {
	var req lifecycleRequest
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &req); err != nil {
			return err
		}
	}
	cfg := pluginConfig{}
	if len(req.ConfigYAML) > 0 {
		if err := yaml.Unmarshal(req.ConfigYAML, &cfg); err != nil {
			return err
		}
	}
	currentConfig.Store(cfg)
	logLine(cfg, map[string]any{"event": "configure", "header": cfg.headerName(), "allow_missing_header": cfg.AllowMissingHeader})
	return nil
}

func loadedConfig() pluginConfig {
	if cfg, ok := currentConfig.Load().(pluginConfig); ok {
		return cfg
	}
	return pluginConfig{}
}

func pluginRegistration() registration {
	return registration{
		SchemaVersion: pluginabi.SchemaVersion,
		Metadata: pluginapi.Metadata{
			Name:             pluginName,
			Version:          pluginVersion,
			Author:           "agy-together",
			GitHubRepository: "https://github.com/agy-together/agy-scheduler",
			ConfigFields: []pluginapi.ConfigField{
				{Name: "header", Type: pluginapi.ConfigFieldTypeString, Description: "Request header holding comma-separated allowed auth IDs (default X-Agy-Allow)."},
				{Name: "allow_missing_header", Type: pluginapi.ConfigFieldTypeBoolean, Description: "If true, requests without the header use the built-in scheduler. Default false = reject."},
				{Name: "log_picks", Type: pluginapi.ConfigFieldTypeBoolean, Description: "Log one line per pick decision to stderr (default true)."},
				{Name: "session_ttl", Type: pluginapi.ConfigFieldTypeString, Description: "Default session binding lifetime, e.g. 1h (X-Agy-Session-Ttl overrides)."},
				{Name: "max_sessions", Type: pluginapi.ConfigFieldTypeInteger, Description: "Maximum number of session bindings kept (default 20000)."},
			},
		},
		Capabilities: registrationCapability{Scheduler: true, SchedulerAcrossPriorities: true},
	}
}

func reject(code, reason string) ([]byte, error) {
	return okEnvelope(pluginapi.SchedulerPickResponse{
		Handled:      true,
		Reject:       true,
		RejectCode:   code,
		RejectReason: reason,
	})
}

// headerValues returns every value of name (case-insensitive) and whether the
// header was present at all.
func headerValues(headers map[string][]string, name string) ([]string, bool) {
	var out []string
	found := false
	for key, values := range headers {
		if strings.EqualFold(key, name) {
			found = true
			out = append(out, values...)
		}
	}
	return out, found
}

func parseAllowList(raw string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func pickAuth(raw []byte) ([]byte, error) {
	var req pluginapi.SchedulerPickRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err // error envelope -> CPA fails the pick
	}
	cfg := loadedConfig()
	seq := pickSeq.Add(1)
	candidateIDs := make([]string, 0, len(req.Candidates))
	for _, c := range req.Candidates {
		candidateIDs = append(candidateIDs, c.ID)
	}
	base := map[string]any{
		"event": "pick", "seq": seq, "model": req.Model, "stream": req.Stream,
		"provider": req.Provider, "candidates": candidateIDs,
	}

	values, present := headerValues(req.Options.Headers, cfg.headerName())
	// Host-internal executions (another plugin calling host.model.execute, e.g. Lamplighter's
	// window ignition) carry no client API key and may use any account. Client requests
	// always carry a caller scope, so they can never take this path.
	if !present && metaString(req.Options.Metadata, "caller_scope") == "" {
		if pinned := metaString(req.Options.Metadata, "pinned_auth_id"); pinned != "" {
			for _, c := range req.Candidates {
				if strings.TrimSpace(c.ID) == pinned {
					base["decision"] = "pick"
					base["reason"] = "host_pinned"
					base["chosen"] = pinned
					logLine(cfg, base)
					return okEnvelope(pluginapi.SchedulerPickResponse{AuthID: pinned, Handled: true})
				}
			}
		}
		// Not pinned, or the pinned auth isn't a candidate right now: let the built-in scheduler decide,
		// so the caller gets CPA's own answer (e.g. auth_not_found / cooldown) instead of ours.
		base["decision"] = "builtin"
		base["reason"] = "host_internal"
		logLine(cfg, base)
		return okEnvelope(pluginapi.SchedulerPickResponse{Handled: false})
	}
	if !present {
		if cfg.AllowMissingHeader {
			base["decision"] = "builtin"
			base["reason"] = "header_missing_allowed"
			logLine(cfg, base)
			return okEnvelope(pluginapi.SchedulerPickResponse{Handled: false})
		}
		base["decision"] = "reject"
		base["reason"] = "header_missing"
		logLine(cfg, base)
		return reject("agy_allow_missing", "request carries no allowed-account list")
	}
	if len(values) != 1 {
		// Two copies means something upstream failed to strip a client value.
		base["decision"] = "reject"
		base["reason"] = "header_duplicated"
		logLine(cfg, base)
		return reject("agy_allow_invalid", "allowed-account header appears more than once")
	}
	allowed := parseAllowList(values[0])
	base["allowed"] = allowed
	if len(allowed) == 0 {
		base["decision"] = "reject"
		base["reason"] = "allow_list_empty"
		logLine(cfg, base)
		return reject("agy_allow_empty", "allowed-account list is empty")
	}
	if len(allowed) > maxAllowedIDs {
		base["decision"] = "reject"
		base["reason"] = "allow_list_too_long"
		logLine(cfg, base)
		return reject("agy_allow_invalid", "allowed-account list too long")
	}
	allowSet := make(map[string]struct{}, len(allowed))
	for _, id := range allowed {
		allowSet[id] = struct{}{}
	}

	// Allowed candidates (any tier), and among them the highest priority tier.
	allowedCand := make(map[string]struct{}, len(req.Candidates))
	eligible := make([]string, 0, len(req.Candidates))
	bestPriority := 0
	for _, c := range req.Candidates {
		id := strings.TrimSpace(c.ID)
		if _, ok := allowSet[id]; !ok || id == "" {
			continue
		}
		allowedCand[id] = struct{}{}
		switch {
		case len(eligible) == 0 || c.Priority > bestPriority:
			eligible = append(eligible[:0], id)
			bestPriority = c.Priority
		case c.Priority == bestPriority:
			eligible = append(eligible, id)
		}
	}
	if len(eligible) == 0 {
		base["decision"] = "reject"
		base["reason"] = "no_allowed_candidate"
		logLine(cfg, base)
		return reject("auth_unavailable", "no allowed account is available for this request")
	}

	mode, session, ttl := sessionParams(req.Options.Headers, cfg)
	base["mode"] = mode
	lruMu.Lock()
	chosen, how := choose(mode, session, req.Model, ttl, cfg.maxSessions(), eligible, allowedCand)
	lastPicked[chosen] = nowFunc().UnixNano()
	lruMu.Unlock()

	base["decision"] = "pick"
	base["chosen"] = chosen
	base["how"] = how
	logLine(cfg, base)
	return okEnvelope(pluginapi.SchedulerPickResponse{AuthID: chosen, Handled: true})
}

// sessionParams reads mode / session / ttl. A missing or duplicated value falls
// back to performance (no stickiness); it never widens the allowed list.
func sessionParams(headers map[string][]string, cfg pluginConfig) (string, string, time.Duration) {
	mode := modePerformance
	if v, ok := headerValues(headers, modeHeader); ok && len(v) == 1 {
		switch m := strings.ToLower(strings.TrimSpace(v[0])); m {
		case modeCache, modeBalance:
			mode = m
		}
	}
	session := ""
	if v, ok := headerValues(headers, sessionHeader); ok && len(v) == 1 {
		session = strings.TrimSpace(v[0])
		if len(session) > maxSessionKeyLen {
			session = ""
		}
	}
	if session == "" {
		mode = modePerformance
	}
	ttl := cfg.sessionTTL()
	if v, ok := headerValues(headers, ttlHeader); ok && len(v) == 1 {
		var sec int64
		if _, err := fmt.Sscan(strings.TrimSpace(v[0]), &sec); err == nil && sec >= 60 && sec <= 7*86400 {
			ttl = time.Duration(sec) * time.Second
		}
	}
	return mode, session, ttl
}

// lru returns the least-recently-picked id; ties keep candidate order. Caller holds lruMu.
func lru(ids []string) string {
	chosen := ids[0]
	best := lastPicked[chosen]
	for _, id := range ids[1:] {
		if t := lastPicked[id]; t < best {
			chosen, best = id, t
		}
	}
	return chosen
}

// choose applies the mode. Every returned id is in eligible or allowedCand
// (both subsets of the allowed list). Caller holds lruMu.
func choose(mode, session, model string, ttl time.Duration, maxSessions int, eligible []string, allowedCand map[string]struct{}) (string, string) {
	if mode == modePerformance {
		return lru(eligible), "lru"
	}
	now := nowFunc().UnixNano()
	key := session + "|" + model
	b := bindings[key]
	if b != nil && b.expires <= now {
		delete(bindings, key)
		b = nil
	}
	if b == nil {
		chosen := lru(eligible)
		putBinding(key, &binding{primary: chosen, primaryAt: now, expires: now + int64(ttl)}, maxSessions, now)
		return chosen, "bind"
	}
	b.expires = now + int64(ttl)
	if _, ok := allowedCand[b.primary]; ok {
		b.primaryAt = now
		b.standIn = ""
		return b.primary, "sticky"
	}
	// cache: the bound auth is missing (cooling down, already tried in this
	// request, or held back by the portal's per-account concurrency cap).
	if mode == modeCache && now-b.primaryAt < int64(cacheGrace) {
		if _, ok := allowedCand[b.standIn]; ok && b.standIn != "" {
			return b.standIn, "stand_in"
		}
		b.standIn = lru(eligible)
		return b.standIn, "stand_in_new"
	}
	// balance, or cache grace over: rebind.
	chosen := lru(eligible)
	if _, ok := allowedCand[b.standIn]; ok && b.standIn != "" && mode == modeCache {
		chosen = b.standIn
	}
	b.primary, b.primaryAt, b.standIn = chosen, now, ""
	return chosen, "rebind"
}

// putBinding stores b, evicting expired entries and then the oldest when full. Caller holds lruMu.
func putBinding(key string, b *binding, maxSessions int, now int64) {
	if len(bindings) >= maxSessions {
		for k, v := range bindings {
			if v.expires <= now {
				delete(bindings, k)
			}
		}
		for len(bindings) >= maxSessions {
			oldKey, oldExp := "", int64(0)
			for k, v := range bindings {
				if oldKey == "" || v.expires < oldExp {
					oldKey, oldExp = k, v.expires
				}
			}
			delete(bindings, oldKey)
		}
	}
	bindings[key] = b
}

func logLine(cfg pluginConfig, fields map[string]any) {
	if !cfg.logPicks() {
		return
	}
	fields["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.Marshal(fields)
	if err != nil {
		return
	}
	fmt.Fprintf(os.Stderr, "[agy-scheduler] %s\n", raw)
}

func okEnvelope(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}

func metaString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}
