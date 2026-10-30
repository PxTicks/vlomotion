# Using H3 Motion

Start by uploading an image or video. Images open **Select → Isolate → Move →
Generate**; MP4/WebM videos open **Draw mask → Animate → Generate**.

## Photos

Selection starts with a prompt; clicking the photo reveals the point editor.
Search results show the subject list, where checkboxes include subjects and pencil
buttons open their mask editor. **Add subject** temporarily opens the prompt and
points for a separate selection. **Apply** always submits points explicitly and
returns to the list on success; **Cancel** discards the temporary changes. Applied
points stay with each subject as its recipe. Mask edits recompute from the starting
mask and the full current point list, so removing a point removes its effect.
Applying an empty recipe restores a text-found mask or removes a point-created
subject. Point-created subjects recompute from points without a prior mask. Delete
and Ctrl+Z (Cmd+Z on Mac) manage the collection without inference. Dashed outlines
show suggestions, blue shows included subjects, and yellow marks the editing target.
The Isolate phase describes the confirmed subject locally with Qwen3-VL, removes
it with Qwen Image 2.1, and previews the clean background. Retry with a new seed,
edit the removal instruction, or hold the preview to compare with the original.
The Move phase keyframes the subject along a path with a timeline and real-time
preview playback. The Generate phase renders those frames in the browser and
animates them with MiniMax H3 and Time-to-Move, with sound.

The photo canvas works while ComfyUI is offline; selecting a subject needs the
GPU services. Images keep their native ratio, with no aspect-ratio picker
or crop. Large photos are downscaled to a working short edge of at most 960 px
and a long edge of at most 2560 px; smaller photos are not enlarged. Replacing
the photo or changing the selection clears the confirmed mask and background.
After confirming, choose **Isolate**.
Retries reuse the subject description; editing the instruction reruns only removal.
The instruction editor becomes available after isolation and shows the exact
prompt used for that confirmed mask. If isolation fails, **Write removal instruction**
opens a blank editor so you can supply an instruction and skip description.
An invalid VLM phrase can use a valid subject from the VLM caption; if neither
identifies the subject, automatic removal stops and offers this manual recovery.
The search hint is never used as an automatic fallback removal target.
Changing the selection clears the old prompt;
isolate again to describe the new highlighted subject. Point edits drop the old
search hint because they can select a different object. For text detections, the
hint stays tied to the submitted search; typing a new name alone doesn't change it.
Submit **Find subject** to create a selection with the new name. User-written
instructions are labelled **Custom removal instruction**, including when a VLM
caption is cached. Manual runs without a model description don't populate that
cache. Missing caption fields use defaults without blocking a valid removal phrase.

**Continue** opens the Move phase. Every included subject has its own path and
colour. Click a subject on the canvas to activate it; overlapping subjects receive
clicks from front to back. The **Subjects** menu also selects subjects, and its
arrows change the layer order. The top row is in front. Paths, diamond keys and
the active subject's timeline use that subject's colour.
Drag the subject to record a path automatically. Recording is available only
while that subject has no path; use **Clear path** to record again. This clears
only the active subject's path. To keyframe instead, scrub the timeline before
the first drag. Each drag then places a key at the playhead, so you can scrub,
drag, scrub and drag again. Scrubbing back to 0 s or pressing play switches
recording back on. Dragging a subject along an existing path adjusts its position
at the playhead without replacing its other keys.
Drag a ◆ on the canvas to adjust its position, or on the timeline to adjust its
timing. The box around the active subject keys its size at the playhead: drag a
corner to resize it evenly, or an edge to stretch one axis. The opposite side
stays put; hold Alt to resize about the centre, or Shift to free a corner's
aspect ratio. Drag an edge past the opposite edge to mirror the subject, for a
crude turn or flip. Sizes range up to 400% either way and change at a steady
rate between keys, passing straight through zero when an axis flips. Resizing
never records, and **Reset size** on a selected key restores 100%. Click the path to insert a key. Motion uses smooth timing by default.
**Clear path** restores the subject's starting position and removes the path,
keeping the chosen clip length. Each recorded drag is simplified into keys and
timed to fill the clip from the playhead to the end, however long the drag took;
pauses and speed changes keep their proportions.
The first frame is always the original photo. The **Clip length** slider runs
from 3.0 to 15.1 s (73 to 362 frames at 24 fps) in steps of 17 frames, H3's
frame grid, and defaults to 124 frames (5.2 s); keys sit on those frames. The
length changes when the slider is released. **Fit animation to length** scales
every key's time so the animation ends on the last frame, and shortening the
clip past the animation's end fits it the same way. Shortcuts: Space plays,
K adds a key, Delete removes the selected key, and arrow keys step frames.
Retrying the background keeps the paths and layer order. Unchanged subjects keep
their paths when the selection changes; a new photo resets all paths. Preview and
video rendering composite every subject using its own path and the chosen order.

**Continue** opens Generate. The workflow uses **25 sampling steps**.
**Motion lock-in** uses a slider from **2 to 15** in whole steps, default **6**, setting the step
at which the subject is released from your path. Higher values hold it longer but
leave H3 less room to blend the cut-out into the scene. **GENERATE** renders the
reference and mask videos in a Web Worker, encodes exactly the clip's
frame count with mediabunny (H.264 MP4, or VP9 WebM where H.264 isn't available),
uploads them with the start frame and runs the animate workflow. **Source |
Result** switches between the frames H3 receives and the generated video.
**Main prompt** is always visible and starts with the generated subject and path
description. Edit it to change the visual instructions. **Advanced** holds the
resolution (480p or 768p, measured on the output's short edge), fixed seed, **Sound effects
[Optional]**, and **Music [Optional]**. Sound effects start with the suggested
scene ambience; music starts blank. The H3 header and section labels are added
when submitting the prompt, so they do not appear in the text boxes.
**Regenerate** runs again with a new seed. A result is marked out of date when
the motion or settings change afterwards.
Cancellation or a failed retry keeps the last successful background.

## Videos

Start by uploading an image or video. Images open the existing Select → Isolate →
Move → Generate workflow. MP4/WebM videos open Draw mask → Animate → Generate:
draw a rectangle or ellipse, then animate it with the same path, key and resize
tools as Move, or have it follow an object, then add a prompt and optional
reference image (`<Picture 1>`). The reference can be uploaded, created as an
object from a description (Qwen Image text-to-image), or created as a frame: the
frame at the playhead, edited by Qwen Image inside the mask. With a reference,
the prompt is laid out in MiniMax's full-reference sections: an object is
defined as `<Subject 1>`, and an edited frame as a `<Picture 1>` keyframe anchor
of the shot. Video preparation keeps the source ratio at a
480p short edge, at 24 fps and up to the first 362 frames (15 s), trimmed to H3's 17k+5
frame grid. ComfyUI stretches source and mask onto a nearby model-valid canvas,
then restores the output ratio before saving.

**Original sound** under Advanced decides what happens to the source's sound. **Reference**
(the default) sends it to H3 as `<Audio 1>` (`ref_audio_1`), so the generated sound takes
on its ambience and style; the prompt defines it with an `audio reference` retention line.
**Preserve** also lets H3 hear it, as `audio reuse`, but the delivered video keeps the
original sound unchanged instead of the generated one, so the sound effect and music boxes
are hidden. **Replace** leaves the sound out of the prepared source video altogether, so H3
never hears it and generates sound from the prompt alone; the server rejects a source that
doesn't match the chosen option. For Reference and Preserve, the browser trims the sound to
the prepared frames and re-encodes it as AAC or Opus. A video without sound is always replaced.
