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

type app struct {
	mu       sync.Mutex
	ready    bool
	scheme   string
	cli      string // VS Code CLI used to open URIs; empty means xdg-open
	sessions []Session
	clients  int
	idle     *time.Timer
	notify   *notifier
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
	defer func() {
		c.Close()
		a.mu.Lock()
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
	scheme, cli := a.scheme, a.cli
	a.mu.Unlock()
	// A summary of several sessions has none; its click shows the view.
	uri := showURI(scheme)
	if m.Session != nil {
		uri = sessionURI(scheme, *m.Session)
	}
	if err := a.notify.show(m.Title, m.Body, m.Icon, func() { openURI(cli, uri) }, desktopEntry(scheme)); err != nil {
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
	scheme, cli := a.scheme, a.cli
	sessions := append([]Session(nil), a.sessions...)
	a.mu.Unlock()

	systray.SetIcon(iconPNG(len(sessions) > 0))
	systray.SetTooltip(tooltip(len(sessions)))
	systray.ResetMenu()
	shown, more := menuSessions(sessions)
	for _, s := range shown {
		item := systray.AddMenuItem(menuLabel(s), s.Title)
		if icon := agentIcon(s.Agent); icon != nil {
			item.SetIcon(icon)
		}
		uri := sessionURI(scheme, s)
		go func() {
			for range item.ClickedCh {
				openURI(cli, uri)
			}
		}()
	}
	if more > 0 {
		systray.AddMenuItem(moreLabel(more), "").Disable()
	}
	if len(sessions) > 0 {
		systray.AddSeparator()
	}
	about := systray.AddMenuItem("About", "Agent Sessions on the VS Code Marketplace")
	go func() {
		for range about.ClickedCh {
			openWeb(marketplaceURL)
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
	a := &app{scheme: "vscode"}
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
