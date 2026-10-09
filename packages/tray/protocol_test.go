package main

import "testing"

func TestDecodeState(t *testing.T) {
	m, err := decodeMessage([]byte(`{"type":"state","scheme":"vscode-insiders","sessions":[{"machine":"local","machineName":"This machine","agent":"claude","id":"a1","title":"Fix tests"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != "state" || m.Scheme != "vscode-insiders" || len(m.Sessions) != 1 || m.Sessions[0].Title != "Fix tests" {
		t.Fatalf("unexpected %+v", m)
	}
}

func TestDecodeNotify(t *testing.T) {
	m, err := decodeMessage([]byte(`{"type":"notify","title":"Fix tests","body":"This machine · /w","session":{"machine":"local","agent":"codex","id":"b2"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != "notify" || m.Session == nil || m.Session.Agent != "codex" {
		t.Fatalf("unexpected %+v", m)
	}
}

func TestDecodeSummaryNotifyWithoutSession(t *testing.T) {
	m, err := decodeMessage([]byte(`{"type":"notify","title":"4 sessions need attention","body":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Session != nil || m.Title != "4 sessions need attention" {
		t.Fatalf("unexpected %+v", m)
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	for _, line := range []string{"", "{", `{"type":"bogus"}`, `{"type":"notify"}`, `{"type":"notify","session":{"machine":"local","agent":"claude","id":"a"}}`, `{"type":"state"}`} {
		if _, err := decodeMessage([]byte(line)); err == nil {
			t.Errorf("accepted %q", line)
		}
	}
}

func TestDecodeStateCli(t *testing.T) {
	m, err := decodeMessage([]byte(`{"type":"state","scheme":"vscode","cli":"/usr/share/code/bin/code","sessions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Cli != "/usr/share/code/bin/code" {
		t.Fatalf("cli = %q", m.Cli)
	}
}
