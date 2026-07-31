import dagre from "@dagrejs/dagre";

/**
 * Client-side controller for the reasoning-trace digraph.
 *
 * Node cards + inspector panels are rendered server-side; this module lays them
 * out with dagre, draws SVG edges, and wires pan/zoom + selection + node drag.
 * Keeping the markup in Astro means all styling stays in Tailwind — JS only
 * positions and toggles.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD = 3; // px of screen movement before a press becomes a drag

interface NodePos {
  x: number; // center
  y: number; // center
  w: number;
  h: number;
}

interface Pt {
  x: number;
  y: number;
}

interface EdgeObj {
  from: string;
  to: string;
  el: SVGPathElement;
}

export function initGraph() {
  const viewport = document.querySelector("#graph-viewport");
  const world = document.querySelector("#graph-world");
  const svg = document.querySelector("#graph-edges") as SVGSVGElement | null;
  const dock = document.querySelector("#inspector-dock");
  if (!(viewport && world && svg)) {
    return;
  }

  const cards = [...world.querySelectorAll<HTMLElement>("[data-node]")];
  const byId = new Map<string, HTMLElement>();
  for (const c of cards) {
    const id = c.dataset.recordId;
    if (id) {
      byId.set(id, c);
    }
  }

  // --- layout ---------------------------------------------------------------
  const g = new dagre.graphlib.Graph();
  g.setGraph({ marginx: 40, marginy: 40, nodesep: 48, rankdir: "TB", ranksep: 84 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const c of cards) {
    const id = c.dataset.recordId as string;
    g.setNode(id, { height: c.offsetHeight, width: c.offsetWidth });
  }

  const edgePairs: [string, string][] = [];
  for (const c of cards) {
    const id = c.dataset.recordId as string;
    const deps = new Set<string>();
    try {
      for (const u of JSON.parse(c.dataset.upstream || "[]") as string[]) {
        deps.add(u);
      }
    } catch {
      /* ignore malformed */
    }
    if (c.dataset.parent) {
      deps.add(c.dataset.parent);
    }
    for (const dep of deps) {
      if (byId.has(dep)) {
        g.setEdge(dep, id);
        edgePairs.push([dep, id]);
      }
    }
  }

  dagre.layout(g);

  const pos = new Map<string, NodePos>();
  for (const c of cards) {
    const id = c.dataset.recordId as string;
    const n = g.node(id);
    if (!n) {
      continue;
    }
    pos.set(id, { h: n.height, w: n.width, x: n.x, y: n.y });
    c.style.left = `${n.x - n.width / 2}px`;
    c.style.top = `${n.y - n.height / 2}px`;
  }

  const graphInfo = g.graph();
  const worldW = graphInfo.width ?? 1000;
  const worldH = graphInfo.height ?? 1000;
  svg.setAttribute("width", String(worldW));
  svg.setAttribute("height", String(worldH));
  svg.setAttribute("viewBox", `0 0 ${worldW} ${worldH}`);

  // --- edges ----------------------------------------------------------------
  // Smooth curve through a routed poly-line (dagre's points weave between nodes,
  // so edges don't cut across cards).
  function smoothPath(pts: Pt[]): string {
    if (pts.length < 2) {
      return "";
    }
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
    }
    const last = pts.at(-1) as Pt;
    return `${d} L ${last.x} ${last.y}`;
  }

  // Direct vertical S-curve between two node borders — used while dragging,
  // when the pre-computed routing no longer matches the moved node.
  function directPath(from: string, to: string): string {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!(a && b)) {
      return "";
    }
    const sx = a.x;
    const sy = a.y + a.h / 2;
    const tx = b.x;
    const ty = b.y - b.h / 2;
    const midY = (sy + ty) / 2;
    return `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
  }

  function routedPath(from: string, to: string): string {
    const e = g.edge(from, to) as { points?: Pt[] } | undefined;
    if (e?.points && e.points.length >= 2) {
      return smoothPath(e.points);
    }
    return directPath(from, to);
  }

  const edgeObjs: EdgeObj[] = [];
  const edgesByNode = new Map<string, EdgeObj[]>();
  for (const [from, to] of edgePairs) {
    if (!(pos.has(from) && pos.has(to))) {
      continue;
    }
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", routedPath(from, to));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "rgba(245,240,235,0.16)");
    el.setAttribute("stroke-width", "1.5");
    svg.append(el);
    const edge: EdgeObj = { el, from, to };
    edgeObjs.push(edge);
    for (const nodeId of [from, to]) {
      const list = edgesByNode.get(nodeId) ?? [];
      list.push(edge);
      edgesByNode.set(nodeId, list);
    }
  }

  // --- pan / zoom -----------------------------------------------------------
  const view = { scale: 1, x: 0, y: 0 };
  const MIN = 0.25;
  const MAX = 2.5;

  function apply() {
    world!.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function fit() {
    const rect = viewport!.getBoundingClientRect();
    const scale = Math.min(rect.width / worldW, rect.height / worldH, 1) * 0.9;
    view.scale = Math.max(MIN, Math.min(MAX, scale || 1));
    view.x = (rect.width - worldW * view.scale) / 2;
    view.y = Math.max(24, (rect.height - worldH * view.scale) / 2);
    apply();
  }

  // Readable default: node cards at (near) full size, anchored top-centre so
  // the root is visible and the user pans downward through the trace. A tall
  // graph shouldn't be shrunk to fit its full height on load.
  function initialView() {
    const rect = viewport!.getBoundingClientRect();
    const scale = Math.max(0.6, Math.min(1, (rect.width * 0.72) / worldW));
    view.scale = scale;
    view.x = (rect.width - worldW * scale) / 2;
    view.y = 96;
    apply();
  }

  function zoomBy(factor: number, cx?: number, cy?: number) {
    const rect = viewport!.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const next = Math.max(MIN, Math.min(MAX, view.scale * factor));
    const k = next / view.scale;
    // keep the point under the cursor stationary
    view.x = px - (px - view.x) * k;
    view.y = py - (py - view.y) * k;
    view.scale = next;
    apply();
  }

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );

  // drag to pan (only when starting on the canvas background, not a card)
  let panning = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  viewport.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-node]")) {
      return;
    }
    panning = true;
    sx = e.clientX;
    sy = e.clientY;
    ox = view.x;
    oy = view.y;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!panning) {
      return;
    }
    view.x = ox + (e.clientX - sx);
    view.y = oy + (e.clientY - sy);
    apply();
  });
  const endPan = () => {
    panning = false;
    viewport.style.cursor = "";
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  for (const btn of document.querySelectorAll<HTMLElement>("[data-zoom]")) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.zoom;
      if (mode === "in") {
        zoomBy(1.2);
      } else if (mode === "out") {
        zoomBy(1 / 1.2);
      } else {
        fit();
      }
    });
  }

  // --- node drag ------------------------------------------------------------
  // A press that moves past the threshold is a drag (repositions the node and
  // its edges); a press that doesn't is a click (selects the node).
  for (const c of cards) {
    let drag: { id: string; cx: number; cy: number; ox: number; oy: number; moved: boolean } | null =
      null;

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) {
        return;
      }
      const id = c.dataset.recordId;
      const p = id ? pos.get(id) : undefined;
      if (!(id && p)) {
        return;
      }
      e.stopPropagation(); // don't let the viewport start a pan
      drag = { cx: e.clientX, cy: e.clientY, id, moved: false, ox: p.x, oy: p.y };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    });

    c.addEventListener("pointermove", (e) => {
      if (!drag) {
        return;
      }
      const dx = e.clientX - drag.cx;
      const dy = e.clientY - drag.cy;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }
      drag.moved = true;
      c.classList.add("dragging-node");
      const p = pos.get(drag.id);
      if (!p) {
        return;
      }
      // screen delta → world delta (undo the zoom scale)
      p.x = drag.ox + dx / view.scale;
      p.y = drag.oy + dy / view.scale;
      c.style.left = `${p.x - p.w / 2}px`;
      c.style.top = `${p.y - p.h / 2}px`;
      for (const ed of edgesByNode.get(drag.id) ?? []) {
        ed.el.setAttribute("d", directPath(ed.from, ed.to));
      }
    });

    const finishDrag = (e: PointerEvent) => {
      if (!drag) {
        return;
      }
      try {
        c.releasePointerCapture?.(e.pointerId);
      } catch {
        /* nothing to release */
      }
      c.classList.remove("dragging-node");
      const { id, moved } = drag;
      drag = null;
      e.stopPropagation();
      if (!moved) {
        select(id); // a plain click opens the inspector
      }
    };
    c.addEventListener("pointerup", finishDrag);
    c.addEventListener("pointercancel", finishDrag);
  }

  // --- selection + inspector ------------------------------------------------
  const inspectors = dock ? [...dock.querySelectorAll<HTMLElement>("[data-inspector]")] : [];
  const inspectorById = new Map<string, HTMLElement>();
  for (const ins of inspectors) {
    const id = ins.dataset.recordId;
    if (id) {
      inspectorById.set(id, ins);
    }
  }

  function resetTabs(ins: HTMLElement) {
    const btns = ins.querySelectorAll<HTMLElement>("[data-tab]");
    const panels = ins.querySelectorAll<HTMLElement>("[data-tabpanel]");
    btns.forEach((b, i) => b.classList.toggle("tab-active", i === 0));
    panels.forEach((p) => {
      p.hidden = p.dataset.tabpanel !== "overview";
    });
  }

  function select(id: string) {
    for (const c of cards) {
      c.classList.toggle("selected", c.dataset.recordId === id);
    }
    if (dock) {
      dock.hidden = false;
    }
    for (const ins of inspectors) {
      ins.hidden = ins.dataset.recordId !== id;
    }
    const active = inspectorById.get(id);
    if (active) {
      resetTabs(active);
    }
  }

  function deselect() {
    for (const c of cards) {
      c.classList.remove("selected");
    }
    for (const ins of inspectors) {
      ins.hidden = true;
    }
    if (dock) {
      dock.hidden = true;
    }
  }

  // click on empty canvas clears selection
  viewport.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-node]")) {
      deselect();
    }
  });

  // inspector interactions: close, tabs, copy, dep-jump
  if (dock) {
    dock.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;

      const closeBtn = target.closest("[data-inspector-close]");
      if (closeBtn) {
        deselect();
        return;
      }

      const tabBtn = target.closest<HTMLElement>("[data-tab]");
      if (tabBtn) {
        const ins = tabBtn.closest<HTMLElement>("[data-inspector]");
        if (!ins) {
          return;
        }
        const name = tabBtn.dataset.tab;
        ins
          .querySelectorAll<HTMLElement>("[data-tab]")
          .forEach((b) => b.classList.toggle("tab-active", b === tabBtn));
        ins.querySelectorAll<HTMLElement>("[data-tabpanel]").forEach((p) => {
          p.hidden = p.dataset.tabpanel !== name;
        });
        return;
      }

      const copyBtn = target.closest<HTMLElement>("[data-copy]");
      if (copyBtn?.dataset.copy) {
        try {
          await navigator.clipboard.writeText(copyBtn.dataset.copy);
        } catch {
          /* clipboard unavailable */
        }
        return;
      }

      const depBtn = target.closest<HTMLElement>("[data-dep]");
      if (depBtn?.dataset.dep && byId.has(depBtn.dataset.dep)) {
        const id = depBtn.dataset.dep;
        select(id);
        centerOn(id);
      }
    });
  }

  function centerOn(id: string) {
    const p = pos.get(id);
    if (!p) {
      return;
    }
    const rect = viewport!.getBoundingClientRect();
    view.x = rect.width / 2 - p.x * view.scale;
    view.y = rect.height / 2 - p.y * view.scale;
    apply();
  }

  // --- init -----------------------------------------------------------------
  initialView();
  window.addEventListener("resize", initialView);
}
