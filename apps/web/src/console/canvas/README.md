# Visual canvas — F35

`editor.tsx` edits the canonical host scene. It is collapsed until the version is live,
and it sits under the rehearsal so testing comes first.

- **Moving and resizing:** pointer drags clamp to the screen. An object dropped wholly
  inside another open area is re-homed there. Area grips move an area with its objects,
  and the corner grip resizes. Arrow keys move, Shift moves by 1, and Alt resizes.
- **Shortcuts and validation:** quick layouts (`../../scenes/layouts.ts`) move the
  standard areas. Validation names the object at fault, and the board marks it.
- **Wording:** status, change list, timing table and history use plain language.
- **Requests:** `api.ts` validates private scene API responses. Exact version and revision
  identity, plus abort epochs, fence stale responses. Local invalid edits never become live
  authority.

The renderer and browser wire schema live in `../../scenes`, and quick proof, scenario
playback and the live overlay all call them.

- **Panels:** each panel hugs its text inside the node box, anchored to the nearest screen
  edge. Empty panels draw nothing. Round status reads “1:32 left”, “Paused · 0:40 left” or
  “Round over”. Instructions page whole lines at readable sizes.
- **Private previews:** these may draw a well-formed draft that breaks a layout rule. Live
  views draw only fully valid layouts.
- **Live overlay (`live.ts`):** text is planned whenever scenes or sessions change. Shared
  instructions merge, conflicting scoreboards move to free space in their own area, and
  effects get even-odd `clip-path` holes over other interactions' text and protected
  areas. The community card takes a cached, card-sized free box near a screen edge.

Saving creates an immutable revision. Applying requires all of the following:

- an active approved behavior
- the exact digest and revision
- host geometry checks
- no emergency stop
- no collision with another live interaction's protected area

Moves inside approved areas use the configuration path; broader edits need explicit review.
`GET`/save/apply responses carry `sharing` notes that explain shared space. Undo creates a
new revision. Behavior changes use the existing authoring and review pipeline, and inherit
the previously approved presentation.
