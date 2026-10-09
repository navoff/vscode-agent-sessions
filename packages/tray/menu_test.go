package main

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestSessionURICarriesBase64URLJSON(t *testing.T) {
	got := sessionURI("vscode", Session{Machine: "my box", MachineName: "Box", Agent: "claude", ID: "a&b", Title: "T"})
	// The extension's uriHandler.test.ts parses this exact string.
	want := "vscode://navoff.vscode-agent-sessions/open?s=eyJtYWNoaW5lIjoibXkgYm94IiwiYWdlbnQiOiJjbGF1ZGUiLCJpZCI6ImFcdTAwMjZiIn0"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(u.Query().Get("s"))
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]string
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if len(p) != 3 || p["machine"] != "my box" || p["agent"] != "claude" || p["id"] != "a&b" {
		t.Fatalf("payload %v", p)
	}
}

func TestShowURI(t *testing.T) {
	if got := showURI("vscodium"); got != "vscodium://navoff.vscode-agent-sessions/show" {
		t.Fatal(got)
	}
}

func TestBadSchemeFallsBackToVscode(t *testing.T) {
	if got := showURI("javascript:alert(1)//"); !strings.HasPrefix(got, "vscode://") {
		t.Fatal(got)
	}
	if got := showURI(""); !strings.HasPrefix(got, "vscode://") {
		t.Fatal(got)
	}
}

func TestMenuLabel(t *testing.T) {
	if got := menuLabel(Session{Title: "Fix tests", MachineName: "This machine"}); got != "Fix tests · This machine" {
		t.Fatal(got)
	}
	long := strings.Repeat("x", 80)
	got := menuLabel(Session{Title: long, MachineName: "box"})
	if len([]rune(got)) > 70 || !strings.HasSuffix(got, " · box") || !strings.Contains(got, "…") {
		t.Fatal(got)
	}
	if got := menuLabel(Session{Title: "  Fix\n\tthe   tests ", MachineName: "my\nbox"}); got != "Fix the tests · my box" {
		t.Fatalf("whitespace: %q", got)
	}
	if got := menuLabel(Session{Title: "fix_flaky_test", MachineName: "dev_box"}); got != "fix__flaky__test · dev__box" {
		t.Fatalf("mnemonic: %q", got)
	}
	// Shortening never splits an escaped underscore.
	got = menuLabel(Session{Title: strings.Repeat("_", 80), MachineName: "box"})
	if want := strings.Repeat("__", maxTitleRunes-1) + "… · box"; got != want {
		t.Fatalf("long underscores: %q", got)
	}
}

func TestMenuSessionsCap(t *testing.T) {
	list := func(n int) []Session { return make([]Session, n) }
	for _, c := range []struct{ n, shown, more int }{{0, 0, 0}, {15, 15, 0}, {16, 15, 1}, {40, 15, 25}} {
		shown, more := menuSessions(list(c.n))
		if len(shown) != c.shown || more != c.more {
			t.Errorf("menuSessions(%d) = %d, %d; want %d, %d", c.n, len(shown), more, c.shown, c.more)
		}
	}
	if moreLabel(25) != "and 25 more…" {
		t.Fatal(moreLabel(25))
	}
}

func TestTooltip(t *testing.T) {
	if tooltip(0) != "Agent Sessions" || tooltip(1) != "Agent Sessions: 1 session needs attention" || tooltip(2) != "Agent Sessions: 2 sessions need attention" {
		t.Fatal("tooltip")
	}
}

func TestDesktopEntry(t *testing.T) {
	for scheme, want := range map[string]string{
		"vscode":          "code",
		"vscode-insiders": "code-insiders",
		"vscodium":        "codium",
		"cursor":          "",
		"":                "",
	} {
		if got := desktopEntry(scheme); got != want {
			t.Errorf("desktopEntry(%q) = %q, want %q", scheme, got, want)
		}
	}
}
