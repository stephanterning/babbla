const NOISE_OPTIONS = [
  { value: "off", label: "Av" },
  { value: "lite", label: "Lätt" },
  { value: "full", label: "Stark" },
];

const VIEW_MARGIN = 8;
const MENU_GAP = 8;
const MENU_MIN_HEIGHT = 96;

function normString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function readModel(model = {}) {
  return {
    mics: Array.isArray(model.mics) ? model.mics : [],
    cams: Array.isArray(model.cams) ? model.cams : [],
    speakers: Array.isArray(model.speakers) ? model.speakers : [],
    micOptions: Array.isArray(model.micOptions) ? model.micOptions : [],
    cameraOptions: Array.isArray(model.cameraOptions) ? model.cameraOptions : [],
    speakerOptions: Array.isArray(model.speakerOptions) ? model.speakerOptions : [],
    micId: normString(model.micId),
    camId: normString(model.camId),
    speakerId: normString(model.speakerId),
    noiseLevel: normString(model.noiseLevel, "lite"),
    isIOS: !!model.isIOS,
    supportsAudioSink: !!model.supportsAudioSink,
  };
}

function mapOptions(options, activeValue, control) {
  const selected = normString(activeValue);
  return options.map((option) => ({
    control,
    value: normString(option.value),
    label: option.label || option.text || "",
    checked: normString(option.value) === selected,
  }));
}

export function buildMenuModel(model, kind) {
  const m = readModel(model);
  if (kind === "camera") {
    if (m.cameraOptions.length < 1) return { kind, sections: [] };
    return {
      kind,
      sections: [
        {
          id: "camera",
          title: "Kamera",
          items: mapOptions(m.cameraOptions, m.camId, "camera"),
        },
      ],
    };
  }

  const sections = [];
  // iOS routes audio devices mostly via system UI, but when WebKit does expose
  // selectable microphone inputs we should surface them in the quick menu.
  if (m.micOptions.length > 0 && (m.mics.length >= 2 || m.isIOS)) {
    sections.push({
      id: "mic",
      title: "Mikrofon",
      items: mapOptions(m.micOptions, m.micId, "mic"),
    });
  }
  if (!m.isIOS && m.supportsAudioSink && m.speakers.length >= 2 && m.speakerOptions.length > 0) {
    sections.push({
      id: "speaker",
      title: "Högtalare",
      items: mapOptions(m.speakerOptions, m.speakerId, "speaker"),
    });
  }
  sections.push({
    id: "noise",
    title: "Brusreducering",
    items: mapOptions(NOISE_OPTIONS, m.noiseLevel, "noise"),
  });

  return { kind: "audio", sections };
}

export function computeMenuPlacement({
  anchorRect,
  menuSize,
  viewport,
  gap = MENU_GAP,
  margin = VIEW_MARGIN,
}) {
  const menuW = Math.max(0, Math.round(menuSize.width || 0));
  const menuH = Math.max(0, Math.round(menuSize.height || 0));
  const viewportW = Math.max(0, Math.round(viewport.width || 0));
  const viewportH = Math.max(0, Math.round(viewport.height || 0));
  const leftMin = margin;
  const leftMax = Math.max(margin, viewportW - menuW - margin);
  const left = Math.min(Math.max(anchorRect.left, leftMin), leftMax);

  const above = anchorRect.top - gap - margin;
  const below = viewportH - anchorRect.bottom - gap - margin;
  let openUp = false;
  if (above >= menuH) openUp = true;
  else if (below >= menuH) openUp = false;
  else openUp = above >= below;

  const available = Math.max(0, openUp ? above : below);
  const maxHeight = menuH > available ? Math.max(MENU_MIN_HEIGHT, available) : null;
  let top;
  if (openUp) {
    top = anchorRect.top - gap - (maxHeight || menuH);
    top = Math.max(margin, top);
  } else {
    top = anchorRect.bottom + gap;
    const limit = Math.max(margin, viewportH - (maxHeight || menuH) - margin);
    top = Math.min(limit, top);
  }

  return {
    left,
    top,
    openUp,
    maxHeight,
  };
}

function itemKey(control, value) {
  return `${control}:${normString(value)}`;
}

export function createDeviceMenu({
  menuEl,
  getModel,
  actions,
  onOpenChange = () => {},
}) {
  /** @type {{ anchorEl: HTMLElement, kind: "audio" | "camera" } | null} */
  let openState = null;

  function setAnchorOpen(anchorEl, openUp) {
    anchorEl.classList.add("is-open");
    anchorEl.classList.toggle("opens-down", !openUp);
    anchorEl.setAttribute("aria-expanded", "true");
  }

  function clearAnchorOpen(anchorEl) {
    anchorEl.classList.remove("is-open", "opens-down");
    anchorEl.setAttribute("aria-expanded", "false");
  }

  function currentItems() {
    return [...menuEl.querySelectorAll(".fs-device-item")];
  }

  function applyAction(control, value) {
    switch (control) {
      case "mic":
        return actions.switchMicrophone?.(value);
      case "speaker":
        return actions.switchSpeaker?.(value);
      case "camera":
        return actions.switchCamera?.(value);
      case "noise":
        return actions.setNoiseReduction?.(value);
      default:
        return undefined;
    }
  }

  function moveFocus(step) {
    const items = currentItems();
    if (!items.length) return;
    const focused = document.activeElement;
    let index = items.indexOf(focused);
    if (index < 0) index = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
    if (index < 0) index = 0;
    const next = (index + step + items.length) % items.length;
    items[next].focus();
  }

  function applyPlacement() {
    if (!openState) return;
    const anchorRect = openState.anchorEl.getBoundingClientRect();
    const menuSize = {
      width: menuEl.offsetWidth,
      height: menuEl.offsetHeight,
    };
    const placement = computeMenuPlacement({
      anchorRect,
      menuSize,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
    menuEl.style.left = `${placement.left}px`;
    menuEl.style.top = `${placement.top}px`;
    if (placement.maxHeight !== null) {
      menuEl.style.maxHeight = `${placement.maxHeight}px`;
      menuEl.style.overflowY = "auto";
    } else {
      menuEl.style.maxHeight = "";
      menuEl.style.overflowY = "";
    }
    setAnchorOpen(openState.anchorEl, placement.openUp);
  }

  function renderMenu({ preserveFocusKey = null } = {}) {
    if (!openState) return false;
    const model = buildMenuModel(getModel(), openState.kind);
    if (!model.sections.length) return false;

    const fragment = document.createDocumentFragment();
    for (const section of model.sections) {
      const sectionEl = document.createElement("section");
      sectionEl.className = "fs-device-section";

      const titleEl = document.createElement("p");
      titleEl.className = "fs-device-section-title";
      titleEl.textContent = section.title;
      sectionEl.append(titleEl);

      const listEl = document.createElement("div");
      listEl.className = "fs-device-items";
      listEl.setAttribute("role", "group");
      listEl.setAttribute("aria-label", section.title);

      for (const item of section.items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fs-device-item";
        btn.dataset.control = item.control;
        btn.dataset.value = item.value;
        btn.setAttribute("role", "menuitemradio");
        btn.setAttribute("aria-checked", String(!!item.checked));
        btn.tabIndex = -1;

        const label = document.createElement("span");
        label.className = "fs-device-item-label";
        label.textContent = item.label;
        const mark = document.createElement("span");
        mark.className = "fs-device-item-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "✓";
        btn.append(label, mark);
        listEl.append(btn);
      }
      sectionEl.append(listEl);
      fragment.append(sectionEl);
    }

    menuEl.replaceChildren(fragment);
    menuEl.hidden = false;
    menuEl.style.visibility = "hidden";
    applyPlacement();
    menuEl.style.visibility = "";

    const items = currentItems();
    const target = items.find((item) =>
      preserveFocusKey
        ? itemKey(item.dataset.control, item.dataset.value) === preserveFocusKey
        : item.getAttribute("aria-checked") === "true",
    ) || items[0];
    target?.focus();
    return true;
  }

  function close({ restoreFocus = true } = {}) {
    if (!openState) return false;
    const prev = openState;
    openState = null;
    clearAnchorOpen(prev.anchorEl);
    menuEl.hidden = true;
    menuEl.replaceChildren();
    menuEl.style.maxHeight = "";
    menuEl.style.overflowY = "";
    menuEl.style.left = "";
    menuEl.style.top = "";
    onOpenChange(false);
    if (restoreFocus) {
      try {
        prev.anchorEl.focus();
      } catch {}
    }
    return true;
  }

  function open(anchorEl, kind) {
    if (!anchorEl || (kind !== "audio" && kind !== "camera")) return false;
    if (openState && openState.anchorEl === anchorEl && openState.kind === kind) {
      close();
      return false;
    }
    if (openState) close({ restoreFocus: false });
    openState = { anchorEl, kind };
    const ok = renderMenu();
    if (!ok) {
      openState = null;
      clearAnchorOpen(anchorEl);
      return false;
    }
    onOpenChange(true);
    return true;
  }

  function refresh() {
    if (!openState) return;
    const focusEl = document.activeElement;
    const key =
      focusEl?.classList?.contains("fs-device-item")
        ? itemKey(focusEl.dataset.control, focusEl.dataset.value)
        : null;
    if (!renderMenu({ preserveFocusKey: key })) close({ restoreFocus: false });
  }

  function reposition() {
    if (!openState || menuEl.hidden) return;
    applyPlacement();
  }

  function onMenuClick(e) {
    const btn = e.target.closest(".fs-device-item");
    if (!btn) return;
    const { control } = btn.dataset;
    const value = normString(btn.dataset.value);
    close({ restoreFocus: false });
    // No "already active" short-circuit: the menu marks the *live* device, which
    // can be a fallback while a higher pick is away. Swallowing the click would
    // leave the user no way to say "actually, use this one" — see device-stack.js.
    Promise.resolve(applyAction(control, value)).catch(() => {});
  }

  function onMenuKeydown(e) {
    if (!openState) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
      return;
    }
    if (e.key === "Tab") close({ restoreFocus: false });
  }

  function onDocumentPointerDown(e) {
    if (!openState) return;
    const target = e.target;
    if (menuEl.contains(target) || openState.anchorEl.contains(target)) return;
    close({ restoreFocus: false });
  }

  menuEl.addEventListener("click", onMenuClick);
  menuEl.addEventListener("keydown", onMenuKeydown);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);

  function destroy() {
    close({ restoreFocus: false });
    menuEl.removeEventListener("click", onMenuClick);
    menuEl.removeEventListener("keydown", onMenuKeydown);
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  }

  return {
    open,
    close,
    isOpen: () => !!openState,
    refresh,
    reposition,
    getOpenKind: () => openState?.kind || null,
    destroy,
  };
}
