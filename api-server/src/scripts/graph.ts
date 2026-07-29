import dagre from "@dagrejs/dagre";

/**
 * Client-side controller for the reasoning-trace digraph.
 *
 * Node cards + inspector panels are rendered server-side; this module lays them
 * out with dagre, draws SVG edges, and wires pan/zoom + selection. Keeping the
 * markup in Astro means all styling stays in Tailwind — JS only positions and
 * toggles.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

interface NodePos {
  x: number; // center
  y: number; // center
  w: number;
  h: number;
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
  g.setGraph({ marginx: 40, marginy: 40, nodesep: 40, rankdir: "TB", ranksep: 72 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const c of cards) {
    const id = c.dataset.recordId as string;
    g.setNode(id, { height: c.offsetHeight, width: c.offsetWidth });
  }

  const edges: [string, string][] = [];
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
        edges.push([dep, id]);
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
  for (const [from, to] of edges) {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!(a && b)) {
      continue;
    }
    const sx = a.x;
    const sy = a.y + a.h / 2;
    const tx = b.x;
    const ty = b.y - b.h / 2;
    const midY = (sy + ty) / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(245,240,235,0.16)");
    path.setAttribute("stroke-width", "1.5");
    svg.append(path);
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
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  viewport.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-node]")) {
      return;
    }
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    ox = view.x;
    oy = view.y;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!dragging) {
      return;
    }
    view.x = ox + (e.clientX - sx);
    view.y = oy + (e.clientY - sy);
    apply();
  });
  const endDrag = () => {
    dragging = false;
    viewport.style.cursor = "";
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

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

  for (const c of cards) {
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = c.dataset.recordId;
      if (id) {
        select(id);
      }
    });
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
