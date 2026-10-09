package main

import (
	"strings"
	"testing"
)

func TestNotifyBody(t *testing.T) {
	for in, want := range map[string]string{
		"box · /w":           "box · /w",
		"a & b":              "a &amp; b",
		"<b>bold</b>":        "&lt;b&gt;bold&lt;/b&gt;",
		"&lt; stays literal": "&amp;lt; stays literal",
		`don't "quote"`:      `don't "quote"`,
	} {
		if got := notifyBody(in); got != want {
			t.Errorf("notifyBody(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNotifySummary(t *testing.T) {
	if got := notifySummary("Fix <b> & 'tests'"); got != "Fix <b> & 'tests'" {
		t.Fatalf("summary changed: %q", got)
	}
	got := []rune(notifySummary(strings.Repeat("x", 200)))
	if len(got) != maxSummaryRunes || got[len(got)-1] != '…' {
		t.Fatalf("long summary: %d runes, %q", len(got), string(got))
	}
	if s := strings.Repeat("y", maxSummaryRunes); notifySummary(s) != s {
		t.Fatal("summary at the limit shortened")
	}
}
