# Spaceland

The sequel to Flatland, a maze game about being a two-dimensional creature. Flatland gave a creature a line to see and a plane to walk. Spaceland hands you the next dimension: a first-person maze that goes every way at once, with no gravity and no floor. Turn to look in any direction, fly in any direction, and find the way out.

Each continuous wall has its own paint, which stays fixed and also appears in the map and replay. Corners and gaps start a new wall, and a wall that crosses a wrapping seam stays one wall. Green is reserved for the exit: its light floods along the corridors nearby and bends around corners, but never passes through a wall, so following a green tint is always honest. A headlight turns with you and falls off with distance.

Nothing in the world is special about "up". Your rotation has no horizon to return to, so you can pitch straight over and keep going, and rising means toward the top of your own head.

Ten worlds grow from a single room and one long corridor into mazes with forks, open chambers, and loops. The shortest route runs from 4 voxels with no choices to 96 voxels with 18 junctions. The closed worlds wrap: level 7 joins one axis into a ring, level 8 joins two, and level 10 joins all three, so it has no outside at all. The ring and the three-torus open on a straight sightline right around the world, and the small tetrahedron far down that corridor is your own back.

After each escape, an animated 3D view reveals the world as glass and your route inside it. A tetrahedral creature (Flatland's triangle, with one more dimension) retraces your flight, turning as you turned, with its headlight beam stopping at walls. Only moments of real movement or turning are recorded, so idle time and flight blocked by walls are left out. Replays support pause, scrubbing, 1× / 2× / 4× speed, drag to orbit, and scroll to zoom. On wrapped worlds the route runs on through as many copies of the world as it crossed, without a jump at any seam.

Before entering a world, **Peek map** shows the start (coral), the exit (mint), and, on wrapped worlds, faint copies of the neighboring tiles. From the pause menu, **Give up & see path** ends the attempt and opens your whole route so far. It does not mark the world complete, and you can fly it again.

## Run

Open **index.html** directly in a modern browser. Everything works offline, with no packages, CDN, or installation.

For a local web server, from this folder:

```sh
npm run dev
```

Then open **http://localhost:4319**. Choose another port with `PORT=8000 npm run dev`.

## Controls

- **W / S**: fly forward / backward.
- **A / D**: strafe left / right.
- **Space or R / Shift or F**: rise / sink, relative to your head.
- **Mouse or arrow keys**: look. Entering a world captures the mouse. If the browser refuses, or after a quick Esc, drag to look or click the view to capture again.
- **Q / E**: roll.
- **T**: square up with the nearest walls, a smooth snap to the closest of the 24 wall-aligned orientations.
- **Esc or P**: pause, restart, give up, invert look, or toggle sound (synthesized, off by default).
- On touch devices, drag to look and hold the on-screen buttons to fly and roll.

The ball in the corner is a compass fixed to the world. The letter at its center is the direction you face, and the labels are North, South, East, West, Up, and Down. Up is a label for one axis, not a pull. Beside it, a counter shows distance flown since your last turn. Both also appear during replays, following the recorded flight.

There is no time limit. Leaving the tab pauses the game. Reduced-motion preferences turn off automatic replay playback and the map's slow rotation.

## Implementation

Vanilla JavaScript and raw WebGL 2, with no runtime dependencies. Source lives in `src/`; after editing it, run `npm run build` to regenerate `app.bundle.js`, which also runs from `file://`.

- `src/world.js` holds the voxel grids, seeded maze generation, level definitions, wall painting, and baked occlusion and exit light. Corridors are one voxel wide and walls one voxel thick. The exit is chosen last, after loops and chambers have carved their shortcuts, so it is genuinely far away.
- `src/game.js` holds quaternion orientation, sphere-versus-voxel collision with sliding, thrust with a brief drift, and the movement recording. Positions stay unwrapped, so a seam crossing never teleports the replay.
- `src/render.js` draws voxel faces directly. On wrapped axes the same mesh is instanced around the camera, which makes seams invisible and lets you see your own image. The map and replay reuse that mesh with an additive glass shader.
- `src/app.js` connects controls, screens, pointer lock, saved progress, and the compass ball.

## Verify

```sh
npm test
npm run check
npm run browser-check
```

The tests fly all ten levels with real turning, thrust, and collision; check that the player never enters a wall, that difficulty rises, that every wrapped level needs a seam crossing, and that the ring and three-torus sightlines are clear. They also cover the free-flight frame, roll, squaring up, idle-free recordings, paint uniqueness and continuity across seams, the green-free palette, exit light that stops at walls, and the camera matrix in every orientation.

`npm run browser-check` needs an installed Chrome (set `CHROME_PATH` elsewhere). It launches the game from `file://` in a temporary profile using software WebGL, drives keyboard and mouse input, wins through the real game loop, walks through pause, replay, give-up, and level flows, fails on any page error, and writes screenshots to `artifacts/`. Open them and look: an all-black view passes every check that only asks whether the game ran.
