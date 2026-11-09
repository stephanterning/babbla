import test from "node:test";
import assert from "node:assert/strict";

import { buildMenuModel, computeMenuPlacement } from "../public/js/device-menu.js";

test("buildMenuModel(audio): desktop includes mic + speaker + noise sections", () => {
  const model = buildMenuModel(
    {
      mics: [{ deviceId: "mic1" }, { deviceId: "mic2" }],
      speakers: [{ deviceId: "spk1" }, { deviceId: "spk2" }],
      cams: [{ deviceId: "cam1" }, { deviceId: "cam2" }],
      micOptions: [
        { value: "default", label: "Systemstandard (Mic 2)" },
        { value: "mic1", label: "Mic 1" },
        { value: "mic2", label: "Mic 2" },
      ],
      speakerOptions: [
        { value: "", label: "Systemstandard (Speaker 2)" },
        { value: "spk1", label: "Speaker 1" },
        { value: "spk2", label: "Speaker 2" },
      ],
      cameraOptions: [
        { value: "cam1", label: "Cam 1" },
        { value: "cam2", label: "Cam 2" },
      ],
      micId: "default",
      speakerId: "spk2",
      camId: "cam1",
      noiseLevel: "full",
      isIOS: false,
      supportsAudioSink: true,
    },
    "audio",
  );

  assert.deepEqual(
    model.sections.map((section) => section.id),
    ["mic", "speaker", "noise"],
  );
  assert.equal(
    model.sections.find((section) => section.id === "mic").items.find((item) => item.checked).value,
    "default",
  );
  assert.equal(
    model.sections.find((section) => section.id === "speaker").items.find((item) => item.checked).value,
    "spk2",
  );
  assert.equal(
    model.sections.find((section) => section.id === "noise").items.find((item) => item.checked).value,
    "full",
  );
});

test("buildMenuModel(audio): iOS includes mic + noise but still hides speaker", () => {
  const model = buildMenuModel(
    {
      mics: [{ deviceId: "mic1" }, { deviceId: "mic2" }],
      speakers: [{ deviceId: "spk1" }, { deviceId: "spk2" }],
      micOptions: [
        { value: "mic1", label: "Mic 1" },
        { value: "mic2", label: "Mic 2" },
      ],
      speakerOptions: [
        { value: "", label: "Systemstandard" },
        { value: "spk1", label: "Speaker 1" },
      ],
      micId: "mic2",
      noiseLevel: "lite",
      isIOS: true,
      supportsAudioSink: true,
    },
    "audio",
  );

  assert.deepEqual(
    model.sections.map((section) => section.id),
    ["mic", "noise"],
  );
  assert.equal(
    model.sections.find((section) => section.id === "mic").items.find((item) => item.checked).value,
    "mic2",
  );
  assert.equal(
    model.sections.find((section) => section.id === "noise").items.find((item) => item.checked).value,
    "lite",
  );
});

test("buildMenuModel(camera): hidden when there are no camera options", () => {
  const model = buildMenuModel(
    {
      cameraOptions: [],
      camId: "",
    },
    "camera",
  );
  assert.deepEqual(model.sections, []);
});

test("buildMenuModel(camera): includes active camera when choices exist", () => {
  const model = buildMenuModel(
    {
      cams: [{ deviceId: "cam1" }, { deviceId: "cam2" }],
      cameraOptions: [
        { value: "cam1", label: "Cam 1" },
        { value: "cam2", label: "Cam 2" },
      ],
      camId: "cam2",
    },
    "camera",
  );
  assert.deepEqual(
    model.sections.map((section) => section.id),
    ["camera"],
  );
  assert.equal(model.sections[0].items.find((item) => item.checked).value, "cam2");
});

test("computeMenuPlacement: prefers above when there is room", () => {
  const placement = computeMenuPlacement({
    anchorRect: { left: 800, top: 700, bottom: 744 },
    menuSize: { width: 280, height: 220 },
    viewport: { width: 1280, height: 900 },
  });
  assert.equal(placement.openUp, true);
  assert.equal(placement.top, 472);
});

test("computeMenuPlacement: flips below near top edge", () => {
  const placement = computeMenuPlacement({
    anchorRect: { left: 120, top: 40, bottom: 84 },
    menuSize: { width: 260, height: 220 },
    viewport: { width: 1280, height: 900 },
  });
  assert.equal(placement.openUp, false);
  assert.equal(placement.top, 92);
});

test("computeMenuPlacement: clamps horizontally inside viewport margins", () => {
  const leftEdge = computeMenuPlacement({
    anchorRect: { left: -30, top: 500, bottom: 544 },
    menuSize: { width: 300, height: 200 },
    viewport: { width: 1200, height: 900 },
  });
  assert.equal(leftEdge.left, 8);

  const rightEdge = computeMenuPlacement({
    anchorRect: { left: 1120, top: 500, bottom: 544 },
    menuSize: { width: 300, height: 200 },
    viewport: { width: 1200, height: 900 },
  });
  assert.equal(rightEdge.left, 892);
});

test("computeMenuPlacement: caps height and returns scroll maxHeight when needed", () => {
  const placement = computeMenuPlacement({
    anchorRect: { left: 500, top: 340, bottom: 384 },
    menuSize: { width: 300, height: 620 },
    viewport: { width: 1200, height: 640 },
  });
  assert.equal(placement.openUp, true);
  assert.equal(placement.maxHeight, 324);
  assert.equal(placement.top, 8);
});
