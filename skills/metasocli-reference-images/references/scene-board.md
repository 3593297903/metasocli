# Scene design boards

Read only for `scene` assets.

## Purpose

Lock the usable physical layout, access routes, zones, materials, lighting state, and important camera positions of one story location. Create separate asset IDs for materially different time, weather, damage, dressing, or layout states.

## Default composition

Create a horizontal 16:9 professional film-production “场景空间结构细节设计板” when supported:

- upper title band: the current story's scene name and a concise design-board subtitle;
- upper left/central area: one large scene-wide master view showing the complete spatial relationship;
- middle/lower area: eight detail panels for a complex primary location, or two to four when the handoff describes a genuinely simple location;
- right side: a clearly readable vertical information rail containing all six named categories below, with relevant continuity notes when supplied;
- lower right: a coherent top-down floor plan with named zones, access routes, movement arrows, and camera-position labels derived from this scene;
- black matte board background, fine gold dividers, gold headings, and restrained lighter body copy with a clear type hierarchy;
- refined film-production design presentation showing one coherent location.

No people by default. An empty scene is preferred because the image locks space, not a performance. Include a person only when the upstream handoff explicitly declares a scale figure and identifies it as non-binding.

## Required scene information

Translate the supplied facts into:

- `空间信息`: exact place, period, time, weather, social use, and scale;
- `结构分区`: entrances, exits, paths, work/action areas, foreground/midground/background relationships;
- `光线氛围`: source direction, hardness, color, practical lights, shadow behavior;
- `材质参考`: walls, floor/ground, furniture, vegetation, fixtures, weathering, and story-relevant traces;
- `剧情功能`: only the function stated by the handoff;
- `机位重点`: usable observation, arrival, dialogue, and action axes derived from the fixed layout.

Write the actual scene title, all six information headings and their story-specific content, numbered detail-view labels, and floor-plan/camera labels into the generation prompt, with their placement. Do not reduce the full board to a master view and image collage. `exactText` supplies only user-requested verbatim wording; an empty list does not remove these ordinary board texts. Reference images supply layout and styling only unless another role is explicitly assigned; do not import sample names, dimensions, settings, or story events.

## Presentation

Show the declared space with consistent entrances, connected access routes, credible structure, and matching materials and light across the master view, detail panels, and floor plan. Let the board explain the source layout clearly through photorealistic views and concise production notes.
