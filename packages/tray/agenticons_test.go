package main

import (
	"bytes"
	"testing"
)

func TestAgentIcon(t *testing.T) {
	for _, a := range []string{"claude", "codex", "opencode"} {
		b := agentIcon(a)
		if !bytes.HasPrefix(b, []byte("\x89PNG")) {
			t.Errorf("%s: not a PNG (%d bytes)", a, len(b))
		}
	}
	if agentIcon("unknown") != nil {
		t.Error("unknown agent should have no icon")
	}
	if agentIcon("../main") != nil {
		t.Error("path escape should have no icon")
	}
}
