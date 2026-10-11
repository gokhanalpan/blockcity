#!/usr/bin/env python3
"""Exports the Roblox tile and vehicle models to src/assets/models.json.

Reads the .rbxmx model files produced by the Roblox project's tools/build_rbxmx.py
(rbxmx/models/TileModels.rbxmx and VehicleModels.rbxmx): every model is a list of
coloured boxes, balls, cylinders and wedges, which is exactly what the Three.js
renderer rebuilds.

Usage:
    python3 tools/export_models.py [path/to/district-tycoon]      (default: ../district-tycoon)

Output format (src/assets/models.json):
    {
      "cell": 4,                       # studs per grid cell; the models are in studs
      "tiles":    { "<key>": { "parts": [Part, ...] } },
      "vehicles": { "<key>": { "parts": [Part, ...] } }
    }
    Part = {
      "n": name, "k": "box" | "ball" | "cylinder" | "wedge",
      "s": [sx, sy, sz], "p": [x, y, z], "c": [r, g, b] (0..255), "m": material name,
      "r": [9 numbers, row-major rotation matrix]   (only when not identity)
      "t": transparency 0..1                        (only when > 0)
      "text": "...", "tc": [r, g, b]                (signboards: the label on the front (-Z) face, its colour)
    }
Coordinates are Roblox's: Y up, the model's front faces -Z, pivot at the base centre (y = 0).
Cylinders have their axis along their local X (Roblox convention). Wedges slope down toward -Z.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "district-tycoon"
OUT = ROOT / "src" / "assets" / "models.json"

MATERIALS = {272: "plastic", 816: "concrete", 1088: "metal", 1280: "grass", 848: "brick",
             1568: "glass", 512: "wood", 800: "slate", 1328: "fabric", 1344: "ground"}
SHAPES = {0: "ball", 1: "box", 2: "cylinder"}
IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]


def num(s):
    v = float(s)
    return int(v) if v.is_integer() else round(v, 4)


def props(item):
    out = {}
    for p in item.find("Properties"):
        out[p.get("name")] = p
    return out


def part(item):
    p = props(item)
    name = p["Name"].text
    size = p["size"]
    cf = p["CFrame"]
    packed = int(p["Color3uint8"].text)
    rot = [num(cf.find(f"R{i // 3}{i % 3}").text) for i in range(9)]
    kind = "wedge" if item.get("class") == "WedgePart" else SHAPES.get(int(p["shape"].text) if "shape" in p else 1, "box")
    out = {
        "n": name,
        "k": kind,
        "s": [num(size.find(a).text) for a in "XYZ"],
        "p": [num(cf.find(a).text) for a in "XYZ"],
        "c": [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255],
        "m": MATERIALS.get(int(p["Material"].text), "plastic"),
    }
    if rot != IDENTITY:
        out["r"] = rot
    if "Transparency" in p and float(p["Transparency"].text) > 0:
        out["t"] = num(p["Transparency"].text)
    for gui in item.findall("Item"):
        if gui.get("class") == "SurfaceGui":
            for label in gui.findall("Item"):
                if label.get("class") == "TextLabel":
                    lp = props(label)
                    out["text"] = lp["Text"].text
                    if "TextColor3" in lp:
                        tc = lp["TextColor3"]
                        out["tc"] = [round(float(tc.find(ch).text) * 255) for ch in "RGB"]
    return out


def models(path):
    root = ET.parse(path).getroot()
    out = {}
    for m in root.iter("Item"):
        if m.get("class") != "Model":
            continue
        key = props(m)["Name"].text
        parts = [part(i) for i in m.findall("Item") if i.get("class") in ("Part", "WedgePart")]
        out[key] = {"parts": parts}
    return out


def highway_bridge(bridge, highway):
    """The Highway Bridge isn't in the Roblox game: the bridge's deck, rails and piers with a strip of
    highway asphalt on the deck and the highway's two lane lines on that."""
    parts = [dict(p) for p in bridge["parts"]]
    # the whole tile: roads have no orientation of their own, so a narrower strip would leave seams
    parts.append({"n": "Asphalt", "k": "box", "s": [4, 0.06, 4], "p": [0, 0.575, 0], "c": [45, 47, 55], "m": "slate"})
    for p in highway["parts"]:
        if p["n"].startswith("PreviewLine"):
            q = dict(p)
            q["p"] = [p["p"][0], 0.625, p["p"][2]]
            parts.append(q)
    return {"parts": parts}


def main():
    tiles = models(SRC / "rbxmx" / "models" / "TileModels.rbxmx")
    tiles["highway_bridge"] = highway_bridge(tiles["bridge"], tiles["highway"])
    vehicles = models(SRC / "rbxmx" / "models" / "VehicleModels.rbxmx")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"cell": 4, "tiles": tiles, "vehicles": vehicles}, separators=(",", ":")), encoding="utf-8")
    nparts = sum(len(m["parts"]) for m in tiles.values())
    print(f"wrote {OUT.relative_to(ROOT)}: {len(tiles)} tile models ({nparts} parts), {len(vehicles)} vehicles")


if __name__ == "__main__":
    main()