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
// There are no replies.
type Message struct {
	Type     string    `json:"type"`
	Scheme   string    `json:"scheme,omitempty"`
	Cli      string    `json:"cli,omitempty"`
	Sessions []Session `json:"sessions,omitempty"`
	Title    string    `json:"title,omitempty"`
	Body     string    `json:"body,omitempty"`
	Icon     string    `json:"icon,omitempty"`
	Session  *Session  `json:"session,omitempty"`
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
