# Minecraft Printer
Minecraft Bot that prints images with blocks.

✅ Updated for Minecraft 1.21 using the latest mineflayer APIs.

![](https://raw.githubusercontent.com/MakkusuOtaku/mc-printer/main/examples/shrek.png)

```
draw image.png concrete+terracotta 64x64
```


### Commands

The console now ships with an upgraded command manager that understands quoted arguments (`draw "my image.png" …`) and long-form flags (for example `--origin 10 64 10`). Use the `help` command at any time for a live summary.

#### Connection & status

| Command | Description |
| --- | --- |
| `join [host] [port] [--username name] [--version version]` | Connect the bot to a server. Omitting the host reuses the last one or defaults to `localhost`. |
| `rejoin` | Reconnect using the last saved host, port and username. |
| `status` | Display connection details, current tasks and printer progress. |
| `stop` | Request cancellation of the active build; the bot stops after the current chunk finishes. |

#### Printer configuration

| Command | Description |
| --- | --- |
| `palettes` | List every available palette key that can be combined (e.g. `concrete+terracotta`). |
| `chunk [size]` | Get or set the number of blocks processed per tick while printing. |
| `commands [on|off]` | Toggle between `/setblock` placement and survival-style block placement. |
| `color [average|dominant]` | Pick which stored block colour swatch is used when matching pixels. |
| `mode [rgb|lab]` | Switch colour-distance calculations between RGB and LAB. |
| `settings [key] [value]` | Inspect or update persisted settings (chunk size, command placement, colour mode, etc.). |
| `clear` | Clear the console log buffer. |

#### Building

| Command | Description |
| --- | --- |
| `draw <image> <palette> <width>x<height>` | Build a still image using a palette or palette combination. Optional flags: `--size` (alternate width/height syntax), `--origin x,y,z` (absolute or `~`-relative anchor), `--offset x,y,z` (extra displacement), and `--no-offset` to suppress the default `+1,+0,+1` safety offset. |
| `gif <image> [palette] [size]` | Print animated GIF frames vertically. Flags: `--frame` (single frame index), `--frames` (limit total frames), `--spacing` (vertical spacing), `--origin`, `--offset`, and `--no-offset`. |
| `model <modelPath> <texturePath> [size]` | Render a textured OBJ model using `/setblock`. Supports `--type points` to place vertices only, plus the same `--origin`/`--offset` positioning flags. |
| `sheep <colour_wool>` | Order the bot to shear and collect a specific wool colour while in survival mode. |

#### Help & diagnostics

| Command | Description |
| --- | --- |
| `help [command]` | Show the full command list or detailed usage for a specific entry. |
| `rot` | Placeholder rotation command (logged for compatibility). |

During long builds the console now shows a progress bar, percentage, placed-block totals and the active task name. Issuing `stop` queues a graceful cancellation.