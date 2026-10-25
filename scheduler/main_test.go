package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

type pickResult struct {
	id     string
	reject bool
}

func resetState(t *testing.T) {
	t.Helper()
	off := false
	currentConfig.Store(pluginConfig{LogPicks: &off})
	lruMu.Lock()
	lastPicked = map[string]int64{}
	bindings = map[string]*binding{}
	lruMu.Unlock()
	clock := time.Unix(1_800_000_000, 0)
	nowFunc = func() time.Time { clock = clock.Add(time.Millisecond); return clock }
	t.Cleanup(func() { nowFunc = time.Now })
}

func advance(d time.Duration) {
	prev := nowFunc
	start := prev().Add(d)
	nowFunc = func() time.Time { start = start.Add(time.Millisecond); return start }
}

func pick(t *testing.T, headers map[string][]string, cands ...string) pickResult {
	t.Helper()
	req := pluginapi.SchedulerPickRequest{Model: "claude-sonnet-4-6", Options: pluginapi.SchedulerOptions{Headers: headers}}
	for _, c := range cands {
		req.Candidates = append(req.Candidates, pluginapi.SchedulerAuthCandidate{ID: c})
	}
	raw, _ := json.Marshal(req)
	out, err := pickAuth(raw)
	if err != nil {
		t.Fatal(err)
	}
	var env envelope
	if err := json.Unmarshal(out, &env); err != nil || !env.OK {
		t.Fatalf("bad envelope %s", out)
	}
	var resp pluginapi.SchedulerPickResponse
	if err := json.Unmarshal(env.Result, &resp); err != nil {
		t.Fatal(err)
	}
	return pickResult{id: resp.AuthID, reject: resp.Reject}
}

func hdr(allow, mode, session string) map[string][]string {
	h := map[string][]string{"X-Agy-Allow": {allow}}
	if mode != "" {
		h["X-Agy-Mode"] = []string{mode}
	}
	if session != "" {
		h["X-Agy-Session"] = []string{session}
	}
	return h
}

func TestPerformanceRotatesWithinAllowList(t *testing.T) {
	resetState(t)
	seen := map[string]int{}
	for i := 0; i < 6; i++ {
		r := pick(t, hdr("a,b", "performance", "s1"), "a", "b", "c")
		if r.reject || (r.id != "a" && r.id != "b") {
			t.Fatalf("pick %d = %+v", i, r)
		}
		seen[r.id]++
	}
	if seen["a"] != 3 || seen["b"] != 3 {
		t.Fatalf("want even LRU rotation, got %v", seen)
	}
}

func TestBalanceIsStickyAndRebindsWhenBoundMissing(t *testing.T) {
	resetState(t)
	first := pick(t, hdr("a,b,c", "balance", "s1"), "a", "b", "c").id
	for i := 0; i < 5; i++ {
		if r := pick(t, hdr("a,b,c", "balance", "s1"), "a", "b", "c"); r.id != first {
			t.Fatalf("balance not sticky: %s then %s", first, r.id)
		}
	}
	// another session spreads to a different (LRU) account
	if other := pick(t, hdr("a,b,c", "balance", "s2"), "a", "b", "c").id; other == first {
		t.Fatalf("second session should get a different LRU account")
	}
	// bound auth disappears from candidates -> rebind, and the new binding sticks
	var rest []string
	for _, c := range []string{"a", "b", "c"} {
		if c != first {
			rest = append(rest, c)
		}
	}
	re := pick(t, hdr("a,b,c", "balance", "s1"), rest...).id
	if re == first {
		t.Fatal("must not pick a non-candidate")
	}
	if r := pick(t, hdr("a,b,c", "balance", "s1"), "a", "b", "c"); r.id != re {
		t.Fatalf("balance should keep the new binding %s, got %s", re, r.id)
	}
}

func TestCacheKeepsBindingThroughShortOutage(t *testing.T) {
	resetState(t)
	bound := pick(t, hdr("a,b,c", "cache", "s1"), "a", "b", "c").id
	var others []string
	for _, c := range []string{"a", "b", "c"} {
		if c != bound {
			others = append(others, c)
		}
	}
	stand := pick(t, hdr("a,b,c", "cache", "s1"), others...).id
	if stand == bound {
		t.Fatal("picked a non-candidate")
	}
	if again := pick(t, hdr("a,b,c", "cache", "s1"), others...).id; again != stand {
		t.Fatalf("stand-in should be sticky: %s then %s", stand, again)
	}
	// bound account is back -> return to it
	if r := pick(t, hdr("a,b,c", "cache", "s1"), "a", "b", "c").id; r != bound {
		t.Fatalf("cache mode should return to %s, got %s", bound, r)
	}
	// long outage: after the grace period the stand-in becomes the binding
	stand = pick(t, hdr("a,b,c", "cache", "s1"), others...).id
	advance(cacheGrace + time.Second)
	if r := pick(t, hdr("a,b,c", "cache", "s1"), others...).id; r != stand {
		t.Fatalf("want stand-in %s promoted, got %s", stand, r)
	}
	if r := pick(t, hdr("a,b,c", "cache", "s1"), "a", "b", "c").id; r != stand {
		t.Fatalf("after promotion the session stays on %s, got %s", stand, r)
	}
}

func TestBindingNeverLeavesAllowList(t *testing.T) {
	resetState(t)
	for _, mode := range []string{"cache", "balance"} {
		b := pick(t, hdr("a,b", mode, "s-"+mode), "a", "b", "c").id
		// the next request for the same session has a smaller allow list
		r := pick(t, hdr("c", mode, "s-"+mode), "a", "b", "c")
		if r.reject || r.id != "c" {
			t.Fatalf("%s: bound %s outside new allow list, got %+v", mode, b, r)
		}
		// nothing allowed among candidates -> reject, even with a binding
		if r := pick(t, hdr("a,b", mode, "s-"+mode), "c"); !r.reject {
			t.Fatalf("%s: want reject, got %+v", mode, r)
		}
	}
}

func TestBindingExpiresAndTableIsBounded(t *testing.T) {
	resetState(t)
	b := pick(t, hdr("a,b,c", "balance", "s1"), "a", "b", "c").id
	advance(2 * time.Hour)
	// expired: a fresh LRU pick (b was most recently used, so not b)
	if r := pick(t, hdr("a,b,c", "balance", "s1"), "a", "b", "c").id; r == b {
		t.Fatalf("expired binding should not stick to %s", b)
	}
	// per-request TTL header
	h := hdr("a,b,c", "balance", "s9")
	h["X-Agy-Session-Ttl"] = []string{"120"}
	first := pick(t, h, "a", "b", "c").id
	advance(3 * time.Minute)
	if r := pick(t, h, "a", "b", "c").id; r == first {
		t.Fatalf("120s TTL should have expired")
	}
	off := false
	currentConfig.Store(pluginConfig{LogPicks: &off, MaxSessions: 5})
	for i := 0; i < 50; i++ {
		pick(t, hdr("a,b", "balance", "x"+string(rune('A'+i))), "a", "b")
	}
	if n := len(bindings); n > 5 {
		t.Fatalf("binding table not bounded: %d", n)
	}
}

func TestRejectSemanticsUnchanged(t *testing.T) {
	resetState(t)
	if r := pickMeta(t, map[string][]string{"X-Agy-Mode": {"cache"}, "X-Agy-Session": {"s"}}, map[string]any{"caller_scope": "k1"}, "a"); !r.reject {
		t.Fatal("missing allow header must reject")
	}
	if r := pick(t, map[string][]string{"X-Agy-Allow": {"a", "a"}}, "a"); !r.reject {
		t.Fatal("duplicated allow header must reject")
	}
	if r := pick(t, hdr(" , ", "cache", "s"), "a"); !r.reject {
		t.Fatal("empty allow list must reject")
	}
	// duplicated mode/session headers -> no stickiness, still within the list
	h := map[string][]string{"X-Agy-Allow": {"a,b"}, "X-Agy-Mode": {"cache", "balance"}, "X-Agy-Session": {"s"}}
	if r := pick(t, h, "a", "b", "c"); r.reject || r.id == "c" {
		t.Fatalf("got %+v", r)
	}
}

func pickMeta(t *testing.T, headers map[string][]string, meta map[string]any, cands ...string) pickResult {
	t.Helper()
	req := pluginapi.SchedulerPickRequest{Model: "gemini-3-flash", Options: pluginapi.SchedulerOptions{Headers: headers, Metadata: meta}}
	for _, c := range cands {
		req.Candidates = append(req.Candidates, pluginapi.SchedulerAuthCandidate{ID: c})
	}
	raw, _ := json.Marshal(req)
	out, err := pickAuth(raw)
	if err != nil {
		t.Fatal(err)
	}
	var env envelope
	if err := json.Unmarshal(out, &env); err != nil || !env.OK {
		t.Fatalf("bad envelope %s", out)
	}
	var resp pluginapi.SchedulerPickResponse
	_ = json.Unmarshal(env.Result, &resp)
	return pickResult{id: resp.AuthID, reject: resp.Reject}
}

func TestHostPinnedWithoutCallerScope(t *testing.T) {
	resetState(t)
	// host-internal (e.g. Lamplighter ignition): pinned, no caller scope -> that auth
	if r := pickMeta(t, nil, map[string]any{"pinned_auth_id": "b"}, "b"); r.reject || r.id != "b" {
		t.Fatalf("host pinned: got %+v", r)
	}
	// client request with a caller scope cannot use the pinned path
	if r := pickMeta(t, nil, map[string]any{"pinned_auth_id": "b", "caller_scope": "k1"}, "b"); !r.reject {
		t.Fatal("pinned with caller scope must still require the allow header")
	}
	// internal but pinned auth not a candidate, or not pinned at all -> built-in scheduler decides
	if r := pickMeta(t, nil, map[string]any{"pinned_auth_id": "z"}, "b"); r.reject || r.id != "" {
		t.Fatalf("internal unpinned-candidate should fall to builtin, got %+v", r)
	}
	if r := pickMeta(t, nil, nil, "b"); r.reject || r.id != "" {
		t.Fatalf("internal unpinned should fall to builtin, got %+v", r)
	}
	// a client request without the allow header is still rejected
	if r := pickMeta(t, nil, map[string]any{"caller_scope": "k1"}, "b"); !r.reject {
		t.Fatal("client request without allow header must reject")
	}
	// allow header present -> normal allow-list rules apply even if pinned
	if r := pickMeta(t, hdr("a", "", ""), map[string]any{"pinned_auth_id": "b"}, "b"); !r.reject {
		t.Fatal("allow list must win over pinned")
	}
}
