package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

const extensionID = "navoff.vscode-agent-sessions"

// marketplaceURL is the extension's page, opened by the About menu item.
const marketplaceURL = "https://marketplace.visualstudio.com/items?itemName=" + extensionID

var schemeRe = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)

// safeScheme is the URI scheme of the VS Code build that sent the state
// (vscode, vscode-insiders, vscodium), falling back to plain vscode.
func safeScheme(scheme string) string {
	if schemeRe.MatchString(scheme) {
		return scheme
	}
	return "vscode"
}

// sessionURI opens session s in VS Code. The session travels as one
// base64url parameter, which survives the extra percent-decoding on the VS
// Code side unchanged (see uriRequest.ts).
func sessionURI(scheme string, s Session) string {
	payload, _ := json.Marshal(struct {
		Machine string `json:"machine"`
		Agent   string `json:"agent"`
		ID      string `json:"id"`
	}{s.Machine, s.Agent, s.ID})
	return fmt.Sprintf("%s://%s/open?s=%s", safeScheme(scheme), extensionID, base64.RawURLEncoding.EncodeToString(payload))
}

func showURI(scheme string) string {
	return fmt.Sprintf("%s://%s/show", safeScheme(scheme), extensionID)
}

// desktopEntry is the desktop file name of the VS Code build behind scheme,
// used as the notification's desktop-entry hint; "" means no hint.
func desktopEntry(scheme string) string {
	switch scheme {
	case "vscode":
		return "code"
	case "vscode-insiders":
		return "code-insiders"
	case "vscodium":
		return "codium"
	}
	return ""
}

const (
	maxTitleRunes   = 60
	maxMenuSessions = 15
)

// menuText puts text on one line and escapes "_", which DBusMenu takes for a
// mnemonic marker.
func menuText(text string) string {
	return strings.ReplaceAll(strings.Join(strings.Fields(text), " "), "_", "__")
}

func menuLabel(s Session) string {
	title := []rune(strings.Join(strings.Fields(s.Title), " "))
	if len(title) > maxTitleRunes {
		title = append(title[:maxTitleRunes-1], '…')
	}
	return fmt.Sprintf("%s · %s", menuText(string(title)), menuText(s.MachineName))
}

// menuSessions is the part of the list the menu shows, and how many are left out.
func menuSessions(sessions []Session) ([]Session, int) {
	if len(sessions) <= maxMenuSessions {
		return sessions, 0
	}
	return sessions[:maxMenuSessions], len(sessions) - maxMenuSessions
}

func moreLabel(n int) string {
	return fmt.Sprintf("and %d more…", n)
}

func tooltip(count int) string {
	switch count {
	case 0:
		return "Agent Sessions"
	case 1:
		return "Agent Sessions: 1 session needs attention"
	default:
		return fmt.Sprintf("Agent Sessions: %d sessions need attention", count)
	}
}

// openWeb hands an https URL to the desktop browser.
func openWeb(url string) {
	runOpener("xdg-open", url, nil)
}

// openURI opens uri in VS Code. With cli set it runs the CLI wrapper of the
// running VS Code (`code --open-url`), because the system handler of the
// vscode scheme may call the Electron binary, which rejects --open-url. If
// the CLI fails, or cli is empty, it falls back to xdg-open.
func openURI(cli, uri string) {
	if cli == "" {
		runOpener("xdg-open", uri, nil)
		return
	}
	runOpener(cli, uri, func() { runOpener("xdg-open", uri, nil) }, "--open-url")
}

// runOpener starts name with args and uri in the background and logs a
// failure; onFail, if not nil, then runs once.
func runOpener(name, uri string, onFail func(), args ...string) {
	cmd := exec.Command(name, append(args, uri)...)
	if err := cmd.Start(); err != nil {
		logf("%s %s: %v", name, uri, err)
		if onFail != nil {
			go onFail()
		}
		return
	}
	go func() {
		if err := cmd.Wait(); err != nil {
			logf("%s %s: %v", name, uri, err)
			if onFail != nil {
				onFail()
			}
		}
	}()
}
