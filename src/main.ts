import * as d3 from "d3";
import {
  sankey,
  sankeyJustify,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyLink,
  type SankeyNode
} from "d3-sankey";
import { toPng, toSvg } from "html-to-image";
import "./styles.css";

const SOURCE_COLORS: Record<string, string> = {
  Ekklesia: "#2563eb",
  "Live On-Chain": "#dc2626",
  "Ratified On-Chain": "#7c3aed"
};

const ROOT_COLOR = "#111827";
const OVER_NCL_COLOR = "#eab308";
const PRIORITY_STORAGE_KEY = "cardanoTreasuryVotingPriorities:v1";

type Proposal = {
  proposal_key?: string;
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
type PageName = "sankey" | "priorities";
type VoteChoice = "" | "Yes" | "No" | "Abstain";
type OrderedProposal = {
  proposal: Proposal;
  order: number;
  groupLabel?: string;
  groupTotal?: number;
  groupColor?: string;
};
type PriorityState = {
  order: string[];
  votes: Record<string, VoteChoice>;
};

let currentLegendMetrics: LegendMetric[] = [];
let arrangeMode: ArrangeMode = "budget";
let activePage: PageName = "sankey";
let priorityState: PriorityState = { order: [], votes: {} };
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
const priorityTableEl = requiredElement<HTMLDivElement>("#priority-table");
const voteTotalsEl = requiredElement<HTMLDivElement>("#vote-totals");
const resetPriorityOrderButton = requiredElement<HTMLButtonElement>("#reset-priority-order");
const clearPriorityVotesButton = requiredElement<HTMLButtonElement>("#clear-priority-votes");
const groupByControlEl = requiredElement<HTMLDivElement>("#group-by-control");
const sankeyPageEl = requiredElement<HTMLElement>("#sankey-page");
const prioritiesPageEl = requiredElement<HTMLElement>("#priorities-page");
const prioritiesExportEl = requiredElement<HTMLDivElement>("#priorities-export");
const pageButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".page-tab"));
const arrangeInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[name='arrange']"));

const formatAda = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function selectedSources(): Set<string> {
  return new Set(activeSources);
}

function proposalKey(proposal: Proposal): string {
  return proposal.proposal_key || legacyProposalKey(proposal);
}

function legacyProposalKey(proposal: Proposal): string {
  return `${proposal.source}::${proposal.title}::${proposal.requested_budget_ada}`;
}

function proposalKeyAliases(proposals: Proposal[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const proposal of proposals) {
    const key = proposalKey(proposal);
    aliases.set(key, key);
    aliases.set(legacyProposalKey(proposal), key);
  }
  return aliases;
}

function defaultPriorityOrder(proposals: Proposal[]): string[] {
  return [...proposals]
    .sort((a, b) => b.requested_budget_ada - a.requested_budget_ada || a.title.localeCompare(b.title))
    .map(proposalKey);
}

function savePriorityState(): void {
  localStorage.setItem(PRIORITY_STORAGE_KEY, JSON.stringify(priorityState));
}

function loadPriorityState(proposals: Proposal[]): PriorityState {
  const proposalKeys = new Set(proposals.map(proposalKey));
  const aliases = proposalKeyAliases(proposals);
  let saved: Partial<PriorityState> = {};
  const raw = localStorage.getItem(PRIORITY_STORAGE_KEY);

  if (raw) {
    try {
      saved = JSON.parse(raw) as Partial<PriorityState>;
    } catch {
      saved = {};
    }
  }

  const savedOrder = Array.isArray(saved.order) ? saved.order : [];
  const knownOrder: string[] = [];
  const seenOrder = new Set<string>();
  for (const savedKey of savedOrder) {
    const key = aliases.get(savedKey);
    if (key && proposalKeys.has(key) && !seenOrder.has(key)) {
      knownOrder.push(key);
      seenOrder.add(key);
    }
  }
  const knownOrderSet = new Set(knownOrder);
  const missingOrder = defaultPriorityOrder(proposals).filter((key) => !knownOrderSet.has(key));
  const savedVotes = saved.votes && typeof saved.votes === "object" ? saved.votes : {};
  const votes: Record<string, VoteChoice> = {};

  for (const proposal of proposals) {
    const key = proposalKey(proposal);
    const vote = savedVotes[key] ?? savedVotes[legacyProposalKey(proposal)];
    votes[key] = vote === "Yes" || vote === "No" || vote === "Abstain" ? vote : "";
  }

  return {
    order: [...knownOrder, ...missingOrder],
    votes
  };
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
  if (activePage === "priorities") {
    prioritiesExportEl.classList.add("exporting");
    try {
      const url = await toSvg(prioritiesExportEl, {
        backgroundColor: "#f8fafc",
        style: {
          overflow: "visible"
        }
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cardano-voting-priorities.svg";
      anchor.click();
    } finally {
      prioritiesExportEl.classList.remove("exporting");
    }
    return;
  }

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
  const target = activePage === "priorities" ? prioritiesExportEl : visualizationEl;
  const fileName =
    activePage === "priorities"
      ? "cardano-voting-priorities.png"
      : "cardano-treasury-sankey.png";
  target.classList.add("exporting");
  try {
    const url = await toPng(target, {
      backgroundColor: "#f8fafc",
      pixelRatio: 2,
      style: {
        overflow: "visible"
      }
    });
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    target.classList.remove("exporting");
  }
}

function orderedPriorityProposals(proposals: Proposal[]): Proposal[] {
  const proposalsByKey = new Map(proposals.map((proposal) => [proposalKey(proposal), proposal]));
  return priorityState.order
    .map((key) => proposalsByKey.get(key))
    .filter((proposal): proposal is Proposal => Boolean(proposal));
}

function renderVoteTotals(proposals: Proposal[]): void {
  voteTotalsEl.replaceChildren();
  const totals: Record<Exclude<VoteChoice, "">, number> = {
    Yes: 0,
    Abstain: 0,
    No: 0
  };

  for (const proposal of proposals) {
    const vote = priorityState.votes[proposalKey(proposal)];
    if (vote === "Yes" || vote === "No" || vote === "Abstain") {
      totals[vote] += proposal.requested_budget_ada;
    }
  }

  for (const label of ["Yes", "Abstain", "No"] satisfies Exclude<VoteChoice, "">[]) {
    const item = document.createElement("div");
    item.className = `vote-total ${label.toLowerCase()}`;

    const heading = document.createElement("span");
    heading.textContent = `Total ${label.toUpperCase()}`;

    const value = document.createElement("strong");
    value.textContent = `${formatAda.format(totals[label])} ADA`;

    item.append(heading, value);
    voteTotalsEl.append(item);
  }
}

function updateVoteRowClass(row: HTMLTableRowElement, vote: VoteChoice): void {
  row.classList.remove("vote-yes", "vote-abstain", "vote-no");
  if (vote === "Yes") row.classList.add("vote-yes");
  if (vote === "Abstain") row.classList.add("vote-abstain");
  if (vote === "No") row.classList.add("vote-no");
}

function renderPriorityTable(payload: SankeyPayload): void {
  priorityTableEl.replaceChildren();
  renderVoteTotals(payload.proposals);

  const table = document.createElement("table");
  table.className = "priority-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["#", "Title", "Proposer", "Amount", "Vote"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.append(th);
  }
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  let draggedKey = "";
  let dropped = false;
  const originalOrder = [...priorityState.order];

  const animateRows = (callback: () => void) => {
    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>("tr[data-proposal-key]"));
    const firstRects = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));

    callback();

    rows.forEach((row) => {
      const first = firstRects.get(row);
      if (!first) return;
      const last = row.getBoundingClientRect();
      const deltaY = first.top - last.top;
      if (deltaY === 0) return;
      row.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: "translateY(0)" }
        ],
        { duration: 130, easing: "ease-out" }
      );
    });
  };

  const moveDraggedRow = (targetRow: HTMLTableRowElement | null, insertAfter: boolean) => {
    if (!draggedKey) return;
    const draggedRow = tbody.querySelector<HTMLTableRowElement>(`tr[data-proposal-key="${CSS.escape(draggedKey)}"]`);
    if (!draggedRow || targetRow === draggedRow) return;

    if (!targetRow) {
      if (draggedRow.nextSibling === null) return;
      animateRows(() => tbody.append(draggedRow));
      return;
    }

    if (!insertAfter && draggedRow.nextSibling === targetRow) return;
    if (insertAfter && draggedRow.previousSibling === targetRow) return;

    animateRows(() => {
      if (insertAfter) {
        targetRow.after(draggedRow);
      } else {
        targetRow.before(draggedRow);
      }
    });
  };

  tbody.addEventListener("dragover", (event) => {
    if (!draggedKey) return;
    event.preventDefault();
    const eventTarget = event.target as HTMLElement;
    const targetRow = eventTarget.closest<HTMLTableRowElement>("tr[data-proposal-key]");
    if (!targetRow) {
      moveDraggedRow(null, true);
      return;
    }

    const rect = targetRow.getBoundingClientRect();
    moveDraggedRow(targetRow, event.clientY > rect.top + rect.height / 2);
  });

  const orderFromDom = (): string[] => {
    const order: string[] = [];
    for (const row of Array.from(tbody.children)) {
      const key = (row as HTMLElement).dataset.proposalKey;
      if (key) {
        order.push(key);
      }
    }
    return order.length === originalOrder.length ? order : originalOrder;
  };

  tbody.addEventListener("drop", (event) => {
    if (!draggedKey) return;
    event.preventDefault();
    dropped = true;
    priorityState.order = orderFromDom();
    savePriorityState();
    renderPriorityTable(payload);
  });

  orderedPriorityProposals(payload.proposals).forEach((proposal, index) => {
    const key = proposalKey(proposal);
    const row = document.createElement("tr");
    row.draggable = true;
    row.dataset.proposalKey = key;
    updateVoteRowClass(row, priorityState.votes[key] ?? "");

    row.addEventListener("dragstart", (event) => {
      draggedKey = key;
      dropped = false;
      row.classList.add("dragging");
      document.body.classList.add("priority-dragging");
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
      }
    });

    row.addEventListener("dragend", () => {
      draggedKey = "";
      row.classList.remove("dragging");
      document.body.classList.remove("priority-dragging");
      if (!dropped) {
        priorityState.order = originalOrder;
        renderPriorityTable(payload);
      }
    });

    const rankCell = document.createElement("td");
    rankCell.className = "priority-rank";
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "::";
    const rank = document.createElement("span");
    rank.textContent = String(index + 1);
    rankCell.append(handle, rank);

    const titleCell = document.createElement("td");
    titleCell.className = "priority-title";
    titleCell.textContent = proposal.title;

    const proposerCell = document.createElement("td");
    proposerCell.textContent = proposal.proposer_name || "Unknown proposer";

    const amountCell = document.createElement("td");
    amountCell.className = "amount-cell";
    amountCell.textContent = `${formatAda.format(proposal.requested_budget_ada)} ADA`;

    const voteCell = document.createElement("td");
    const voteSelect = document.createElement("select");
    voteSelect.setAttribute("aria-label", `Vote for ${proposal.title}`);
    for (const optionValue of ["", "Yes", "No", "Abstain"] satisfies VoteChoice[]) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue || "Select";
      voteSelect.append(option);
    }
    voteSelect.value = priorityState.votes[key] ?? "";
    voteSelect.addEventListener("change", () => {
      priorityState.votes[key] = voteSelect.value as VoteChoice;
      savePriorityState();
      updateVoteRowClass(row, priorityState.votes[key]);
      renderVoteTotals(payload.proposals);
    });
    voteCell.append(voteSelect);

    row.append(rankCell, titleCell, proposerCell, amountCell, voteCell);
    tbody.append(row);
  });

  table.append(thead, tbody);
  priorityTableEl.append(table);
}

function setActivePage(page: PageName): void {
  activePage = page;
  sankeyPageEl.hidden = page !== "sankey";
  prioritiesPageEl.hidden = page !== "priorities";
  groupByControlEl.hidden = page !== "sankey";
  pageButtons.forEach((button) => {
    const isActive = button.dataset.page === page;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
}

async function boot(): Promise<void> {
  const response = await fetch("/proposals-sankey.json");
  if (!response.ok) throw new Error(`Unable to load proposals-sankey.json: ${response.status}`);
  const payload = (await response.json()) as SankeyPayload;
  priorityState = loadPriorityState(payload.proposals);
  savePriorityState();
  render(payload);
  renderPriorityTable(payload);
  arrangeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        arrangeMode = input.value as ArrangeMode;
        render(payload);
      }
    });
  });
  pageButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActivePage(button.dataset.page === "priorities" ? "priorities" : "sankey");
    });
  });
  resetPriorityOrderButton.addEventListener("click", () => {
    priorityState.order = defaultPriorityOrder(payload.proposals);
    savePriorityState();
    renderPriorityTable(payload);
  });
  clearPriorityVotesButton.addEventListener("click", () => {
    priorityState.votes = Object.fromEntries(
      payload.proposals.map((proposal) => [proposalKey(proposal), ""])
    ) as Record<string, VoteChoice>;
    savePriorityState();
    renderPriorityTable(payload);
  });
  exportSvgButton.addEventListener("click", () => void exportSvg());
  exportPngButton.addEventListener("click", () => void exportPng());
  window.addEventListener("resize", () => render(payload));
  setActivePage(activePage);
}

void boot().catch((error) => {
  chartEl.textContent = error instanceof Error ? error.message : String(error);
});
