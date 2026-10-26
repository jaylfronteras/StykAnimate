export const SCENARIO_GUIDE = `Build a scene with scenario_build. The spec is JSON.

Canvas
- width and height in pixels, or canvas: "landscape" (960×540), "portrait" (540×960), "square" (720×720).
- fps is an integer, usually 24. seconds (or duration) is the length of the animation.
- background is a hex color. camera, when set, looks at a world point: x and y are the point in the middle of the screen, zoom 1 shows the whole canvas, zoom 2 moves in. rotate is degrees.

Cast
Each member needs a unique id.
- kind "stickman" (the default) is the app's Blue figure. color and headColor are hex. scale defaults to 1. x is the hip. ground is the floor line the feet stand on (y is the hip instead, if you set it). flip true faces screen-left. pose is a name from pose_list, default "stand". thickness multiplies line width.
- kind "line" is a straight prop or floor. x, y, length, thickness, color, rotate (degrees).
- kind "circle" uses radius. filled defaults to true.
- kind "text" uses text, fontSize, color, x, y. bold true uses the bold cut of the bundled font.

Beats
beats run in time order. at is seconds from the start. actor is a cast id.
- motion is idle, walk, run, jump, punch, kick, wave, sit, fall, or nod.
- duration is seconds. walk and run also need to: {x} (the hip they travel to). They face the direction of travel, keep their feet on the ground, and ease out into a stand.
- action is the same idea in one sentence: "walk to x=640 in 1.5s".
- say adds a caption for duration seconds (default 1.6).
- camera and background on a beat hold until a later beat changes them.
- ease on a beat is linear, ease-in, ease-out, ease-in-out, auto, constant, or hold. ease-in-out is stored as a smooth bezier because the file format has no ease-in-out mode.

Timing
The file format stores the last key as one frame. scenario_build adds that closer for you, so the opened project is about one frame longer than seconds × fps. That extra frame is what lets the last pose hold.

Editing afterwards
scenario_build replaces the open project. It keeps a snapshot first; snapshot_restore brings the previous project back. scenario_append and motion_apply add keys to the project that is already open, so use those to keep existing work. pose_set, figure_transform and the keyframe tools do the same.

A few limits
- Figure joints use absolute screen degrees: 0 right, 90 down, -90 up, 180 left. Props store an offset from the joint they are attached to, so they follow when the body moves.
- On a stickman, "left" is the character's left. Facing right, that arm is on the right of the screen. pose_list names (rightUpperArm, foot_l, "Left forearm") all work.
- Layers have visibility, lock, name, order, color and parallax. They do not have opacity. Use figure_style opacity for that.
- IK targets bake into the joint angles unless you pin them with pose_ik_set or figure_ik_setup.
- Paths stay inside STYK_WORKSPACE. project_save never replaces an existing file unless overwrite is true, and then the old bytes are kept as a .bak next to it.

Example
{
  "title": "Ada meets Ben",
  "canvas": "landscape",
  "fps": 24,
  "seconds": 10,
  "background": "#f4f1ea",
  "cast": [
    {"id": "floor", "kind": "line", "x": 40, "y": 430, "length": 880, "thickness": 4, "color": "#c8c2b4"},
    {"id": "ada", "color": "#1d9bf0", "x": 160, "ground": 430},
    {"id": "ben", "color": "#e07a2f", "x": 760, "ground": 430, "flip": true}
  ],
  "beats": [
    {"at": 0, "actor": "ada", "motion": "idle", "duration": 1},
    {"at": 1, "actor": "ada", "motion": "walk", "duration": 2, "to": {"x": 420}},
    {"at": 3.2, "actor": "ada", "motion": "wave", "duration": 1.2, "say": "Hey"},
    {"at": 1, "actor": "ben", "motion": "walk", "duration": 2, "to": {"x": 560}},
    {"at": 4.6, "camera": {"x": 480, "y": 300, "zoom": 1.2}}
  ]
}

Figure design
figure_design takes a criteria object, not a scene spec.
- base is stickman, chibi, tall, or bulky.
- color, headColor, thickness, proportions: {head, torso, arms, legs} as multipliers.
- head is default, round, oval, or square.
- parts is a list of ids from parts_list (hair, hats, sword, staff, shield, cape, scarf, belt).
- name, x, y, scale place it in the open project.
figure_preview draws a sheet of the figure. figure_library_save stores a reusable .stkz copy.
`;
