package main

import "embed"

// Agent icons of the session tree, rendered to PNG by gen-icons.sh, shown
// beside the sessions in the tray menu.
//
//go:embed icons/*.png
var agentIcons embed.FS

// agentIcon is the PNG of the agent's icon, nil for an agent without one.
func agentIcon(agent string) []byte {
	b, err := agentIcons.ReadFile("icons/" + agent + ".png")
	if err != nil {
		return nil
	}
	return b
}
