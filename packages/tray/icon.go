package main

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
)

const iconSize = 22

var (
	strokeColor = color.NRGBA{0xE6, 0xE6, 0xE6, 0xFF}
	dotColor    = color.NRGBA{0x3F, 0xB9, 0x50, 0xFF}
	dotEdge     = color.NRGBA{0x0D, 0x11, 0x17, 0xFF}
)

func fillRect(img *image.NRGBA, x0, y0, x1, y1 int, c color.Color) {
	draw.Draw(img, image.Rect(x0, y0, x1, y1), image.NewUniform(c), image.Point{}, draw.Src)
}

func fillCircle(img *image.NRGBA, cx, cy, r int, c color.Color) {
	for y := cy - r; y <= cy+r; y++ {
		for x := cx - r; x <= cx+r; x++ {
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= r*r {
				img.Set(x, y, c)
			}
		}
	}
}

// iconPNG draws the monitor of the view icon; with dot, a green dot sits on
// its top right corner, like the unread dot of a session.
func iconPNG(dot bool) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))
	// screen: outer 2 px frame
	fillRect(img, 2, 4, 20, 16, strokeColor)
	fillRect(img, 4, 6, 18, 14, color.Transparent)
	// two text lines
	fillRect(img, 6, 8, 11, 9, strokeColor)
	fillRect(img, 6, 11, 14, 12, strokeColor)
	// stand
	fillRect(img, 10, 16, 12, 19, strokeColor)
	fillRect(img, 6, 19, 16, 21, strokeColor)
	if dot {
		fillCircle(img, 17, 5, 5, dotEdge)
		fillCircle(img, 17, 5, 4, dotColor)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}
