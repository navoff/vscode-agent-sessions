package main

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPrivateDir(t *testing.T) {
	root := t.TempDir()
	private := filepath.Join(root, "private")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(private); err != nil {
		t.Fatalf("0700 dir refused: %v", err)
	}
	open := filepath.Join(root, "open")
	if err := os.Mkdir(open, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(open); err == nil {
		t.Fatal("0755 dir accepted")
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(link); err == nil {
		t.Fatal("symlink accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkPrivateDir(file); err == nil {
		t.Fatal("file accepted")
	}
}

func TestListenRefusesSharedDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agent-sessions")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := listen(filepath.Join(dir, "tray.sock")); err == nil {
		t.Fatal("listen accepted a world-writable directory")
	}
}

func TestStoreStateReportsChanges(t *testing.T) {
	a := &app{scheme: "vscode"}
	s := []Session{{Machine: "local", MachineName: "This machine", Agent: "claude", ID: "a", Title: "A"}}
	if a.storeState("vscode", "", nil) {
		t.Fatal("empty state over the initial one counts as a change")
	}
	if !a.storeState("vscode", "", s) {
		t.Fatal("new session not seen")
	}
	if a.storeState("vscode", "", append([]Session(nil), s...)) {
		t.Fatal("same sessions count as a change")
	}
	if !a.storeState("vscode-insiders", "", s) {
		t.Fatal("scheme change not seen")
	}
	if !a.storeState("vscode-insiders", "/usr/share/code/bin/code", s) {
		t.Fatal("cli change not seen")
	}
	changed := append([]Session(nil), s...)
	changed[0].Title = "B"
	if !a.storeState("vscode-insiders", "/usr/share/code/bin/code", changed) {
		t.Fatal("title change not seen")
	}
}

var takesActions = Message{Type: "state", Actions: true}

// pipeWindow is a connected window; the returned reader is the window's end.
func pipeWindow(t *testing.T) (*window, *bufio.Reader, net.Conn) {
	t.Helper()
	helperEnd, windowEnd := net.Pipe()
	t.Cleanup(func() { helperEnd.Close(); windowEnd.Close() })
	return &window{conn: helperEnd}, bufio.NewReader(windowEnd), windowEnd
}

func TestActGoesToTheWindowHeardFromLast(t *testing.T) {
	var opened []string
	a := &app{scheme: "vscode", openURI: func(_, uri string) { opened = append(opened, uri) }}
	first, firstR, _ := pipeWindow(t)
	second, secondR, _ := pipeWindow(t)
	old, oldR, _ := pipeWindow(t)
	a.heard(first, takesActions)
	a.heard(second, takesActions)
	a.heard(old, Message{Type: "state"})
	a.heard(first, Message{Type: "notify", Title: "A"})
	a.heard(old, Message{Type: "notify", Title: "A"})
	go a.act(Action{Type: "open", Session: &SessionRef{Machine: "local", Agent: "claude", ID: "a1"}}, "vscode://x/open")
	line, err := firstR.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != `{"type":"open","session":{"machine":"local","agent":"claude","id":"a1"}}`+"\n" {
		t.Fatalf("line = %q", line)
	}
	go a.act(Action{Type: "show"}, "vscode://x/show")
	if line, _ := firstR.ReadString('\n'); line != `{"type":"show"}`+"\n" {
		t.Fatalf("line = %q", line)
	}
	if secondR.Buffered() != 0 || oldR.Buffered() != 0 || len(opened) != 0 {
		t.Fatalf("another window or the URI used: buffered %d, %d, opened %v", secondR.Buffered(), oldR.Buffered(), opened)
	}
}

func TestActSkipsAGoneWindowAndFallsBackToTheURI(t *testing.T) {
	var opened []string
	a := &app{scheme: "vscode", cli: "/usr/bin/code", openURI: func(cli, uri string) { opened = append(opened, cli+" "+uri) }}
	alive, aliveR, _ := pipeWindow(t)
	gone, _, goneEnd := pipeWindow(t)
	goneEnd.Close()
	a.heard(alive, takesActions)
	a.heard(gone, takesActions)
	go a.act(Action{Type: "readAll"}, "vscode://x/read-all")
	if line, err := aliveR.ReadString('\n'); err != nil || line != `{"type":"readAll"}`+"\n" {
		t.Fatalf("line = %q, %v", line, err)
	}
	a.windows = []*window{gone}
	a.act(Action{Type: "readAll"}, "vscode://x/read-all")
	if len(opened) != 1 || opened[0] != "/usr/bin/code vscode://x/read-all" {
		t.Fatalf("opened = %v", opened)
	}
	a.windows = nil
	a.act(Action{Type: "show"}, "vscode://x/show")
	if len(opened) != 2 {
		t.Fatalf("opened = %v", opened)
	}
}
