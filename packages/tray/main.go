package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"fyne.io/systray"
)

const (
	idleExitDelay  = 5 * time.Second
	startupTimeout = 10 * time.Second
	maxLineBytes   = 1 << 20
	writeTimeout   = time.Second
)

// socketLock is kept for the process lifetime; closing it would drop the flock.
var socketLock *os.File

var errBusy = errors.New("another helper owns the socket")

func logf(format string, args ...any) {
	log.Printf(format, args...)
}

// checkPrivateDir refuses dir unless it is a real directory (not a symlink)
// owned by us that nobody else can enter: otherwise another user could
// replace the socket and feed the menu and notifications.
func checkPrivateDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.IsDir() || !ok || int(st.Uid) != os.Getuid() || fi.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("unsafe socket directory %s: it must be a directory owned by the current user with mode 0700", dir)
	}
	return nil
}

// listen takes the socket, removing a stale file; a socket that answers
// belongs to a running helper.
func listen(path string) (net.Listener, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	// The lock is held for the helper's lifetime, so two helpers starting at
	// once cannot both remove and bind the socket.
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errBusy
		}
		return nil, err
	}
	socketLock = lock
	if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
		c.Close()
		return nil, errBusy
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return ln, nil
}

// window is the connection of one local VS Code window.
type window struct {
	conn    net.Conn
	actions bool       // it said it takes Action lines; guarded by app.mu
	mu      sync.Mutex // one line at a time
}

func (w *window) send(line []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := w.conn.Write(line)
	return err
}

type app struct {
	mu       sync.Mutex
	ready    bool
	scheme   string
	cli      string // VS Code CLI used to open URIs; empty means xdg-open
	sessions []Session
	clients  int
	windows  []*window // those that take clicks, the one heard from last first
	idle     *time.Timer
	notify   *notifier
	openURI  func(cli, uri string)
	renderMu sync.Mutex // serializes render: the menu rebuild is not atomic
}

func (a *app) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		a.mu.Lock()
		a.clients++
		if a.idle != nil {
			a.idle.Stop()
			a.idle = nil
		}
		a.mu.Unlock()
		go a.handle(c)
	}
}

func (a *app) handle(c net.Conn) {
	w := &window{conn: c}
	defer func() {
		c.Close()
		a.mu.Lock()
		a.windows = slices.DeleteFunc(a.windows, func(x *window) bool { return x == w })
		a.clients--
		if a.clients == 0 {
			a.idle = time.AfterFunc(idleExitDelay, systray.Quit)
		}
		a.mu.Unlock()
	}()
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 64*1024), maxLineBytes)
	for sc.Scan() {
		m, err := decodeMessage(sc.Bytes())
		if err != nil {
			logf("ignoring line: %v", err)
			continue
		}
		a.heard(w, m)
		switch m.Type {
		case "state":
			a.setState(m.Scheme, m.Cli, m.Sessions)
		case "notify":
			a.showNotification(m)
		}
	}
	if err := sc.Err(); err != nil {
		logf("client connection: %v", err)
	}
}

// heard puts w first among the windows that clicks go to, once its state
// said it takes them: a window still running an older extension would drop
// the line.
func (a *app) heard(w *window, m Message) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if m.Type == "state" && m.Actions {
		w.actions = true
	}
	if !w.actions || (len(a.windows) > 0 && a.windows[0] == w) {
		return
	}
	a.windows = append([]*window{w}, slices.DeleteFunc(a.windows, func(x *window) bool { return x == w })...)
}

// act hands a click to the window heard from last. Every connected window is
// a local one with the whole list, so it can open any session of this
// machine, handing it over to the window on its folder. The vscode:// URI
// is only the fallback when no window takes the line: VS Code gives it to
// the window focused last, and in a Remote window "This machine" is the
// remote host, which does not have the session.
func (a *app) act(act Action, uri string) {
	line := encodeAction(act)
	a.mu.Lock()
	windows := slices.Clone(a.windows)
	cli := a.cli
	a.mu.Unlock()
	for _, w := range windows {
		err := w.send(line)
		if err == nil {
			return
		}
		logf("handing %s to a window: %v", act.Type, err)
	}
	a.openURI(cli, uri)
}

// storeState keeps the state; true when it differs from the previous one.
// Every window sends the full state after each of its refreshes, mostly
// unchanged, and a menu rebuild is visible in some panels.
func (a *app) storeState(scheme, cli string, sessions []Session) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if scheme == a.scheme && cli == a.cli && slices.Equal(sessions, a.sessions) {
		return false
	}
	a.scheme = scheme
	a.cli = cli
	a.sessions = sessions
	return true
}

func (a *app) setState(scheme, cli string, sessions []Session) {
	if !a.storeState(scheme, cli, sessions) {
		return
	}
	a.mu.Lock()
	ready := a.ready
	a.mu.Unlock()
	if ready {
		a.render()
	}
}

func (a *app) showNotification(m Message) {
	if a.notify == nil {
		logf("no notification service, dropping %q", m.Title)
		return
	}
	a.mu.Lock()
	scheme := a.scheme
	a.mu.Unlock()
	// A summary of several sessions has none; its click shows the view.
	act, uri := Action{Type: "show"}, showURI(scheme)
	if m.Session != nil {
		act, uri = Action{Type: "open", Session: refOf(*m.Session)}, sessionURI(scheme, *m.Session)
	}
	if err := a.notify.show(m.Title, m.Body, m.Icon, func() { a.act(act, uri) }, desktopEntry(scheme)); err != nil {
		logf("notify: %v", err)
	}
}

// render rebuilds the icon, tooltip and menu from the current state. Menu
// items are replaced wholesale; ResetMenu removes the old ones, which closes
// their ClickedCh and ends the goroutines waiting on it.
func (a *app) render() {
	a.renderMu.Lock()
	defer a.renderMu.Unlock()
	a.mu.Lock()
	scheme := a.scheme
	sessions := append([]Session(nil), a.sessions...)
	a.mu.Unlock()

	systray.SetIcon(iconPNG(len(sessions) > 0))
	systray.SetTooltip(tooltip(len(sessions)))
	systray.ResetMenu()
	shown, more := menuSessions(sessions)
	for _, s := range shown {
		a.addSessionMenu(scheme, s)
	}
	if more > 0 {
		systray.AddMenuItem(moreLabel(more), "").Disable()
	}
	if len(sessions) > 0 {
		systray.AddSeparator()
		all := systray.AddMenuItem("Mark all as read", "Mark every waiting session read without opening it")
		uri := readAllURI(scheme)
		go func() {
			for range all.ClickedCh {
				a.act(Action{Type: "readAll"}, uri)
			}
		}()
		systray.AddSeparator()
	}
	about := systray.AddMenuItem("About", "Agent Sessions on the VS Code Marketplace")
	go func() {
		for range about.ClickedCh {
			openWeb(marketplaceURL)
		}
	}()
}

// addSessionMenu adds session s as a submenu: "Open" opens it in VS Code,
// "Mark as read" clears it without opening.
func (a *app) addSessionMenu(scheme string, s Session) {
	item := systray.AddMenuItem(menuLabel(s), s.Title)
	if icon := agentIcon(s.Agent); icon != nil {
		item.SetIcon(icon)
	}
	open := item.AddSubMenuItem("Open", "Open the session in VS Code")
	read := item.AddSubMenuItem("Mark as read", "Mark the session read without opening it")
	openURL, readURL := sessionURI(scheme, s), readURI(scheme, s)
	go func() {
		for range open.ClickedCh {
			a.act(Action{Type: "open", Session: refOf(s)}, openURL)
		}
	}()
	go func() {
		for range read.ClickedCh {
			a.act(Action{Type: "read", Session: refOf(s)}, readURL)
		}
	}()
}

func (a *app) onReady() {
	a.mu.Lock()
	a.ready = true
	a.mu.Unlock()
	a.render()
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("agent-sessions-tray: ")
	socketPath := flag.String("socket", "", "unix socket to listen on")
	flag.Parse()
	if *socketPath == "" {
		fmt.Fprintln(os.Stderr, "usage: agent-sessions-tray --socket PATH")
		os.Exit(2)
	}
	ln, err := listen(*socketPath)
	if errors.Is(err, errBusy) {
		os.Exit(0)
	}
	if err != nil {
		log.Fatal(err)
	}
	a := &app{scheme: "vscode", openURI: openURI}
	if n, err := newNotifier(); err == nil {
		a.notify = n
	} else {
		logf("notifications unavailable: %v", err)
	}
	// Nobody connected: the window that started us gave up.
	a.idle = time.AfterFunc(startupTimeout, systray.Quit)
	go a.serve(ln)
	systray.Run(a.onReady, func() {
		ln.Close()
		_ = os.Remove(*socketPath)
		if a.notify != nil {
			a.notify.close()
		}
	})
}
