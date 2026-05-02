import * as d3 from "d3";
import {
  sankey,
  sankeyJustify,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyLink,
  type SankeyNode
} from "d3-sankey";
import { toPng } from "html-to-image";
import "./styles.css";

const SOURCE_COLORS: Record<string, string> = {
  Ekklesia: "#2563eb",
  "Live On-Chain": "#dc2626",
  "Ratified On-Chain": "#7c3aed"
};

const ROOT_COLOR = "#111827";
const OVER_NCL_COLOR = "#eab308";

type Proposal = {
  title: string;
  proposer_name: string;
  source: "Ekklesia" | "Live On-Chain" | "Ratified On-Chain" | string;
  requested_budget_ada: number;
};

type SankeyPayload = {
  ncl_ada: number;
  proposals: Proposal[];
};

type FlowNode = {
  id: string;
  label: string;
  kind: "root" | "proposal";
  source?: string;
  proposal?: Proposal;
  order?: number;
  groupLabel?: string;
  groupTotal?: number;
  groupColor?: string;
};

type FlowLink = {
  source: string;
  target: string;
  value: number;
  proposal?: Proposal;
};

type GraphNode = SankeyNode<FlowNode, FlowLink>;
type GraphLink = SankeyLink<FlowNode, FlowLink>;
type Graph = SankeyGraph<FlowNode, FlowLink>;
type LegendMetric = {
  label: string;
  value: number;
  color: string;
  source?: string;
};
type ArrangeMode = "budget" | "source" | "proposer";
type OrderedProposal = {
  proposal: Proposal;
  order: number;
  groupLabel?: string;
  groupTotal?: number;
  groupColor?: string;
};

let currentLegendMetrics: LegendMetric[] = [];
let arrangeMode: ArrangeMode = "budget";
const activeSources = new Set(Object.keys(SOURCE_COLORS));

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required page element is missing: ${selector}`);
  }
  return element;
}

const chartEl = requiredElement<HTMLDivElement>("#chart");
const visualizationEl = requiredElement<HTMLDivElement>("#visualization");
const legendEl = requiredElement<HTMLDivElement>("#legend");
const tooltipEl = requiredElement<HTMLDivElement>("#tooltip");
const summaryEl = requiredElement<HTMLParagraphElement>("#summary");
const exportSvgButton = requiredElement<HTMLButtonElement>("#export-svg");
const exportPngButton = requiredElement<HTMLButtonElement>("#export-png");
const arrangeInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[name='arrange']"));

const formatAda = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function selectedSources(): Set<string> {
  return new Set(activeSources);
}

function addNode(nodes: Map<string, FlowNode>, node: FlowNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function orderedProposals(proposals: Proposal[], mode: ArrangeMode): OrderedProposal[] {
  const budgetSort = (a: Proposal, b: Proposal) =>
    b.requested_budget_ada - a.requested_budget_ada || a.title.localeCompare(b.title);

  if (mode === "budget") {
    return [...proposals]
      .sort(budgetSort)
      .map((proposal, order) => ({ proposal, order }));
  }

  const groupKey = (proposal: Proposal) =>
    mode === "source" ? proposal.source : proposal.proposer_name || "Unknown proposer";
  const groups = d3
    .groups(proposals, groupKey)
    .map(([label, items]) => ({
      label,
      total: d3.sum(items, (proposal) => proposal.requested_budget_ada),
      color: mode === "source" ? SOURCE_COLORS[label] ?? "#64748b" : "#64748b",
      items: [...items].sort(budgetSort)
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

  const ordered: OrderedProposal[] = [];
  for (const group of groups) {
    for (const proposal of group.items) {
      ordered.push({
        proposal,
        order: ordered.length,
        groupLabel: group.label,
        groupTotal: group.total,
        groupColor: group.color
      });
    }
  }
  return ordered;
}

function buildGraph(payload: SankeyPayload, allowedSources: Set<string>, mode: ArrangeMode): {
  nodes: FlowNode[];
  links: FlowLink[];
  total: number;
  over: number;
  sourceTotals: Map<string, number>;
} {
  const proposals = payload.proposals
    .filter((proposal) => allowedSources.has(proposal.source));
  const ordered = orderedProposals(proposals, mode);
  const total = d3.sum(proposals, (proposal) => proposal.requested_budget_ada);
  const over = Math.max(0, total - payload.ncl_ada);
  const nodes = new Map<string, FlowNode>();
  const links: FlowLink[] = [];
  const sourceTotals = new Map<string, number>();

  addNode(nodes, { id: "total", label: "Total Requested", kind: "root" });

  ordered.forEach((item) => {
    const { proposal } = item;
    const proposalId = `proposal:${item.order}:${proposal.title}`;
    addNode(nodes, {
      id: proposalId,
      label: proposal.title,
      kind: "proposal",
      source: proposal.source,
      proposal,
      order: item.order,
      groupLabel: item.groupLabel,
      groupTotal: item.groupTotal,
      groupColor: item.groupColor
    });
    links.push({
      source: "total",
      target: proposalId,
      value: proposal.requested_budget_ada,
      proposal
    });
    sourceTotals.set(
      proposal.source,
      (sourceTotals.get(proposal.source) ?? 0) + proposal.requested_budget_ada
    );
  });

  return { nodes: Array.from(nodes.values()), links, total, over, sourceTotals };
}

function nodeColor(node: GraphNode): string {
  if (node.kind === "proposal" && node.source) return SOURCE_COLORS[node.source] ?? "#64748b";
  return ROOT_COLOR;
}

function linkColor(link: GraphLink): string {
  const color = d3.color(SOURCE_COLORS[link.proposal?.source ?? ""] ?? "#64748b")?.rgb();
  if (!color) return "rgba(100, 116, 139, 0.28)";
  return `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
}

function showTooltip(event: MouseEvent, html: string): void {
  tooltipEl.innerHTML = html;
  tooltipEl.style.opacity = "1";
  tooltipEl.style.transform = `translate(${event.clientX + 16}px, ${event.clientY + 16}px)`;
}

function hideTooltip(): void {
  tooltipEl.style.opacity = "0";
}

function renderLegend(payload: SankeyPayload, graphData: ReturnType<typeof buildGraph>): void {
  legendEl.replaceChildren();
  const metrics: LegendMetric[] = [
    { label: "NCL", value: payload.ncl_ada, color: "#15803d" },
    { label: "Total Requested", value: graphData.total, color: ROOT_COLOR },
    { label: "Over NCL", value: graphData.over, color: OVER_NCL_COLOR },
    ...Object.keys(SOURCE_COLORS).map((source) => ({
      label: `${source} Total`,
      value: graphData.sourceTotals.get(source) ?? 0,
      color: SOURCE_COLORS[source],
      source
    }))
  ];
  currentLegendMetrics = metrics;

  for (const metric of metrics) {
    const item = document.createElement(metric.source ? "label" : "div");
    item.className = "legend-item";

    const marker = document.createElement("span");
    marker.className = "legend-marker";

    if (metric.source) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = activeSources.has(metric.source);
      input.style.accentColor = metric.color;
      input.addEventListener("change", () => {
        if (input.checked) {
          activeSources.add(metric.source!);
        } else {
          activeSources.delete(metric.source!);
        }
        render(payload);
      });
      marker.append(input);
    } else {
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = metric.color;
      marker.append(swatch);
    }

    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = metric.label;

    const value = document.createElement("strong");
    value.textContent = `${formatAda.format(metric.value)} ADA`;

    item.append(marker, label, value);
    legendEl.append(item);
  }
}

function tooltipForProposal(proposal: Proposal): string {
  return `<strong>${proposal.title}</strong>
    <span>Proposer: ${proposal.proposer_name || "Unknown proposer"}</span>
    <span>Budget Request: ${formatAda.format(proposal.requested_budget_ada)} ADA</span>`;
}

function truncateLabel(label: string): string {
  const maxLabelLength = 82;
  return label.length > maxLabelLength ? `${label.slice(0, maxLabelLength - 3)}...` : label;
}

function renderGroupAnnotations(svg: d3.Selection<SVGSVGElement, unknown, null, undefined>, graph: Graph, width: number): void {
  if (arrangeMode === "budget") return;

  const proposalNodes = graph.nodes
    .filter((node) => node.kind === "proposal" && node.groupLabel)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups = d3.groups(proposalNodes, (node) => node.groupLabel ?? "");
  const annotationX = Math.max(42, width - 1110);
  const annotationWidth = Math.max(280, width - annotationX - 46);

  const annotations = svg
    .append("g")
    .attr("class", "group-annotations")
    .attr("pointer-events", "none");

  for (const [label, nodes] of groups) {
    const sortedNodes = [...nodes].sort((a, b) => (a.y0 ?? 0) - (b.y0 ?? 0));
    const firstNode = sortedNodes[0];
    const lastNode = sortedNodes[sortedNodes.length - 1];
    const y0 = firstNode.y0 ?? 0;
    const y1 = lastNode.y1 ?? y0;
    const labelY = Math.max(18, y0 - 9);
    const color = firstNode.groupColor ?? "#64748b";
    const total = firstNode.groupTotal ?? d3.sum(nodes, (node) => node.value ?? 0);

    annotations
      .append("line")
      .attr("x1", annotationX)
      .attr("x2", annotationX + annotationWidth)
      .attr("y1", Math.max(20, y0 - 15))
      .attr("y2", Math.max(20, y0 - 15))
      .attr("stroke", color)
      .attr("stroke-opacity", arrangeMode === "source" ? 0.4 : 0.22)
      .attr("stroke-width", 1);

    annotations
      .append("rect")
      .attr("x", annotationX)
      .attr("y", labelY - 13)
      .attr("width", Math.min(annotationWidth, 520))
      .attr("height", 18)
      .attr("rx", 2)
      .attr("fill", "#ffffff")
      .attr("fill-opacity", 0.9);

    annotations
      .append("text")
      .attr("x", annotationX + 8)
      .attr("y", labelY)
      .attr("class", "group-label")
      .attr("fill", arrangeMode === "source" ? color : "#475569")
      .text(`${truncateLabel(label)} - ${formatAda.format(total)} ADA`);

    annotations
      .append("line")
      .attr("x1", annotationX)
      .attr("x2", annotationX)
      .attr("y1", Math.max(20, y0 - 15))
      .attr("y2", y1 + 8)
      .attr("stroke", color)
      .attr("stroke-opacity", arrangeMode === "source" ? 0.35 : 0.18)
      .attr("stroke-width", 1);
  }
}

function render(payload: SankeyPayload): void {
  const allowedSources = selectedSources();
  const graphData = buildGraph(payload, allowedSources, arrangeMode);
  summaryEl.textContent = "";

  chartEl.replaceChildren();
  renderLegend(payload, graphData);

  const proposalCount = Math.max(1, graphData.nodes.filter((node) => node.kind === "proposal").length);
  const groupCount = new Set(
    graphData.nodes
      .filter((node) => node.kind === "proposal" && node.groupLabel)
      .map((node) => node.groupLabel)
  ).size;
  const width = Math.max(chartEl.clientWidth, 1500);
  const height = Math.max(900, proposalCount * 42 + (arrangeMode === "budget" ? 0 : groupCount * 24));
  const svg = d3
    .select(chartEl)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height)
    .attr("role", "img");

  const layout = sankey<FlowNode, FlowLink>()
    .nodeId((node) => node.id)
    .nodeAlign(sankeyJustify)
    .nodeWidth(18)
    .nodePadding(arrangeMode === "budget" ? 18 : 24)
    .nodeSort((a, b) => {
      if (a.kind === "proposal" && b.kind === "proposal") return (a.order ?? 0) - (b.order ?? 0);
      if (a.kind === "root") return -1;
      if (b.kind === "root") return 1;
      return 0;
    })
    .extent([[28, 34], [width - 560, height - 34]]);

  const graph = layout({
    nodes: graphData.nodes.map((node) => ({ ...node })),
    links: graphData.links.map((link) => ({ ...link }))
  }) as Graph;

  svg
    .append("g")
    .attr("fill", "none")
    .selectAll("path")
    .data(graph.links)
    .join("path")
    .attr("d", sankeyLinkHorizontal())
    .attr("stroke", linkColor)
    .attr("stroke-width", (link) => Math.max(1, link.width ?? 1))
    .attr("stroke-opacity", 1)
    .on("mousemove", (event, link) => {
      if (link.proposal) {
        showTooltip(event, tooltipForProposal(link.proposal));
      }
    })
    .on("mouseleave", hideTooltip);

  const node = svg
    .append("g")
    .selectAll("g")
    .data(graph.nodes)
    .join("g");

  node
    .append("rect")
    .attr("x", (d) => d.x0 ?? 0)
    .attr("y", (d) => d.y0 ?? 0)
    .attr("height", (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
    .attr("width", (d) => Math.max(1, (d.x1 ?? 0) - (d.x0 ?? 0)))
    .attr("rx", 2)
    .attr("fill", nodeColor)
    .on("mousemove", (event, d) => {
      if (d.proposal) {
        showTooltip(event, tooltipForProposal(d.proposal));
      } else {
        showTooltip(event, `<strong>${d.label}</strong><span>${formatAda.format(d.value ?? 0)} ADA</span>`);
      }
    })
    .on("mouseleave", hideTooltip);

  node
    .append("text")
    .attr("x", (d) => (d.x1 ?? 0) + 10)
    .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
    .attr("dy", "0.35em")
    .attr("text-anchor", "start")
    .attr("class", (d) => `node-label ${d.kind}`)
    .text((d) => (d.kind === "proposal" ? truncateLabel(d.label) : d.label));

  renderGroupAnnotations(svg, graph, width);
}

async function exportSvg(): Promise<void> {
  const chartSvg = chartEl.querySelector("svg");
  if (!chartSvg) return;

  const namespace = "http://www.w3.org/2000/svg";
  const width = Number(chartSvg.getAttribute("width") ?? 1500);
  const chartHeight = Number(chartSvg.getAttribute("height") ?? 900);
  const columns = Math.min(3, Math.max(1, currentLegendMetrics.length));
  const legendRows = Math.ceil(currentLegendMetrics.length / columns);
  const legendHeight = legendRows * 42 + 24;
  const exportSvgEl = document.createElementNS(namespace, "svg");
  exportSvgEl.setAttribute("xmlns", namespace);
  exportSvgEl.setAttribute("viewBox", `0 0 ${width} ${chartHeight + legendHeight}`);
  exportSvgEl.setAttribute("width", String(width));
  exportSvgEl.setAttribute("height", String(chartHeight + legendHeight));

  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(chartHeight + legendHeight));
  background.setAttribute("fill", "#f8fafc");
  exportSvgEl.append(background);

  const legendGroup = document.createElementNS(namespace, "g");
  legendGroup.setAttribute("transform", "translate(18 14)");
  exportSvgEl.append(legendGroup);

  const columnWidth = (width - 36) / columns;
  currentLegendMetrics.forEach((metric, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = column * columnWidth;
    const y = row * 42;

    const card = document.createElementNS(namespace, "rect");
    card.setAttribute("x", String(x));
    card.setAttribute("y", String(y));
    card.setAttribute("width", String(columnWidth - 8));
    card.setAttribute("height", "34");
    card.setAttribute("fill", "#ffffff");
    card.setAttribute("stroke", "#dbe3ed");
    legendGroup.append(card);

    const swatch = document.createElementNS(namespace, "circle");
    swatch.setAttribute("cx", String(x + 14));
    swatch.setAttribute("cy", String(y + 17));
    swatch.setAttribute("r", "5");
    swatch.setAttribute("fill", metric.color);
    legendGroup.append(swatch);

    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", String(x + 28));
    label.setAttribute("y", String(y + 14));
    label.setAttribute("fill", "#475569");
    label.setAttribute("font-size", "11");
    label.setAttribute("font-weight", "700");
    label.textContent = metric.label.toUpperCase();
    legendGroup.append(label);

    const value = document.createElementNS(namespace, "text");
    value.setAttribute("x", String(x + 28));
    value.setAttribute("y", String(y + 29));
    value.setAttribute("fill", "#111827");
    value.setAttribute("font-size", "13");
    value.setAttribute("font-weight", "700");
    value.textContent = `${formatAda.format(metric.value)} ADA`;
    legendGroup.append(value);
  });

  const chartGroup = document.createElementNS(namespace, "g");
  chartGroup.setAttribute("transform", `translate(0 ${legendHeight})`);
  const chartClone = chartSvg.cloneNode(true) as SVGSVGElement;
  Array.from(chartClone.childNodes).forEach((child) => chartGroup.append(child));
  exportSvgEl.append(chartGroup);

  const blob = new Blob([new XMLSerializer().serializeToString(exportSvgEl)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "cardano-treasury-sankey.svg";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportPng(): Promise<void> {
  const url = await toPng(visualizationEl, { backgroundColor: "#f8fafc", pixelRatio: 2 });
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "cardano-treasury-sankey.png";
  anchor.click();
}

async function boot(): Promise<void> {
  const response = await fetch("/proposals-sankey.json");
  if (!response.ok) throw new Error(`Unable to load proposals-sankey.json: ${response.status}`);
  const payload = (await response.json()) as SankeyPayload;
  render(payload);
  arrangeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        arrangeMode = input.value as ArrangeMode;
        render(payload);
      }
    });
  });
  exportSvgButton.addEventListener("click", () => void exportSvg());
  exportPngButton.addEventListener("click", () => void exportPng());
  window.addEventListener("resize", () => render(payload));
}

void boot().catch((error) => {
  chartEl.textContent = error instanceof Error ? error.message : String(error);
});
