package main

import (
	"encoding/json"
	"errors"
)

// Session is one entry of the attention list, as the extension sends it.
type Session struct {
	Machine     string `json:"machine"`
	MachineName string `json:"machineName"`
	Agent       string `json:"agent"`
	ID          string `json:"id"`
	Title       string `json:"title"`
}

// Message is one JSON line from a VS Code window: the full state, or one
// notification to show, about a session or (Session nil) about several.
// There are no replies; clicks go back as Action lines.
type Message struct {
	Type     string    `json:"type"`
	Actions  bool      `json:"actions,omitempty"` // state: the window takes Action lines
	Scheme   string    `json:"scheme,omitempty"`
	Cli      string    `json:"cli,omitempty"`
	Sessions []Session `json:"sessions,omitempty"`
	Title    string    `json:"title,omitempty"`
	Body     string    `json:"body,omitempty"`
	Icon     string    `json:"icon,omitempty"`
	Session  *Session  `json:"session,omitempty"`
}

// Action is one JSON line to a VS Code window, a click on a notification or
// in the menu: "open" or "read" one session, "readAll", "show" the view. The
// window does what the vscode:// URI of the same click does (see
// uriRequest.ts in the extension).
type Action struct {
	Type    string      `json:"type"`
	Session *SessionRef `json:"session,omitempty"`
}

// SessionRef names a session for an Action.
type SessionRef struct {
	Machine string `json:"machine"`
	Agent   string `json:"agent"`
	ID      string `json:"id"`
}

func refOf(s Session) *SessionRef {
	return &SessionRef{Machine: s.Machine, Agent: s.Agent, ID: s.ID}
}

func encodeAction(act Action) []byte {
	line, _ := json.Marshal(act)
	return append(line, '\n')
}

var errBadMessage = errors.New("bad message")

func decodeMessage(line []byte) (Message, error) {
	var m Message
	if err := json.Unmarshal(line, &m); err != nil {
		return m, err
	}
	switch m.Type {
	case "state":
		if m.Sessions == nil {
			return m, errBadMessage
		}
	case "notify":
		// Without a session the notification sums up several; a click shows the view.
		if m.Title == "" {
			return m, errBadMessage
		}
	default:
		return m, errBadMessage
	}
	return m, nil
}
