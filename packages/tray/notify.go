package main

import (
	"strings"
	"sync"

	"github.com/godbus/dbus/v5"
)

const (
	notifyDest  = "org.freedesktop.Notifications"
	notifyPath  = "/org/freedesktop/Notifications"
	notifyIface = "org.freedesktop.Notifications"
)

const maxSummaryRunes = 120

// bodyEscaper escapes the body for servers with body-markup (Cinnamon, GNOME,
// KDE), "&" first. Only these three: Cinnamon re-escapes any other entity,
// such as the &#39; html.EscapeString writes for an apostrophe.
var bodyEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func notifyBody(body string) string {
	return bodyEscaper.Replace(body)
}

// notifySummary shortens the summary. It is plain text by the specification
// and the servers escape it themselves, so it is not escaped here.
func notifySummary(summary string) string {
	r := []rune(summary)
	if len(r) > maxSummaryRunes {
		return string(append(r[:maxSummaryRunes-1], '…'))
	}
	return summary
}

// notifier shows desktop notifications and opens the session of a clicked one.
type notifier struct {
	conn    *dbus.Conn
	mu      sync.Mutex
	pending map[uint32]func() // notification id -> action on click
}

func newNotifier() (*notifier, error) {
	// A private connection: the shared one also feeds systray, whose
	// re-registration loop exits on any 2-element signal.
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, err
	}
	if err := conn.AddMatchSignal(dbus.WithMatchInterface(notifyIface), dbus.WithMatchMember("ActionInvoked")); err != nil {
		return nil, err
	}
	if err := conn.AddMatchSignal(dbus.WithMatchInterface(notifyIface), dbus.WithMatchMember("NotificationClosed")); err != nil {
		return nil, err
	}
	n := &notifier{conn: conn, pending: map[uint32]func(){}}
	ch := make(chan *dbus.Signal, 16)
	conn.Signal(ch)
	go n.loop(ch)
	return n, nil
}

func (n *notifier) loop(ch chan *dbus.Signal) {
	for sig := range ch {
		if len(sig.Body) < 1 {
			continue
		}
		id, ok := sig.Body[0].(uint32)
		if !ok {
			continue
		}
		n.mu.Lock()
		open, known := n.pending[id]
		delete(n.pending, id)
		n.mu.Unlock()
		if known && sig.Name == notifyIface+".ActionInvoked" {
			open()
		}
	}
}

// show displays a notification; a click on it (the default action) runs open.
// show displays a notification; icon is an absolute path of an image file
// shown beside the summary, or empty for none. It goes only as app_icon:
// the image-path hint would show it a second time, large, in the body.
func (n *notifier) show(title, body, icon string, open func(), entry string) error {
	obj := n.conn.Object(notifyDest, dbus.ObjectPath(notifyPath))
	hints := map[string]dbus.Variant{}
	if entry != "" {
		hints["desktop-entry"] = dbus.MakeVariant(entry)
	}
	var id uint32
	call := obj.Call(notifyIface+".Notify", 0, "Agent Sessions", uint32(0), icon, notifySummary(title), notifyBody(body), []string{"default", "Open"}, hints, int32(-1))
	if err := call.Store(&id); err != nil {
		return err
	}
	n.mu.Lock()
	n.pending[id] = open
	n.mu.Unlock()
	return nil
}

func (n *notifier) close() {
	_ = n.conn.Close()
}
