#!/usr/bin/env python3
"""Fetch Cardano Budget 2026 proposals and print a budget-sorted table."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import textwrap
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "https://hydra-voting.intersectmbo.org"
KOIOS_BASE_URL = "https://api.koios.rest/api/v1"
VOTE_SLUG = "cardano-budget-2026"
PAGES = (1, 2)
LOVELACE_PER_ADA = Decimal("1000000")
NCL_ADA = Decimal("350000000")
NCL_TREASURY_WITHDRAWAL_START_EPOCH = 613
LAST_APPROVED_NCL_ACTION_ID = "gov_action1m3xx08yv788vfxqh6nfvrjtvmqpwezsy0ggaczctkyjmttc2wmxsq4jsr7q"
LAST_APPROVED_NCL_TX_HASH = "dc4c679c8cf1cec49817d4d2c1c96cd802ec8a047a11dc0b0bb125b5af0a76cd"
ON_CHAIN_PROPOSER_OVERRIDES = {
    "Cardano x Draper Dragon: Orion Fund": "Draper Dragon",
    "Amaru Treasury Withdrawal 2026": "Pragma",
    "Cardano Defi Liquidity Budget - Withdrawal 1": "Elder Millenial",
}
PROPOSER_NAME_NORMALIZATIONS = {
    "IntersectMBO": "Intersect",
    "Open Source Committee (Intersect)": "Intersect",
    "IntersectCPC": "Intersect",
    "Intersect Technical Steering Committee": "Intersect",
    "IntersectCBC": "Intersect",
    "Intersect, EMURGO": "EMURGO",
}


@dataclass(frozen=True)
class Proposal:
    title: str
    proposer_name: str
    requested_budget_ada: Decimal
    source: str


@dataclass(frozen=True)
class ProposalResult:
    proposals: list[Proposal]
    api_total: int | None


def fetch_url_json(url: str, data: bytes | None = None) -> Any:
    request = Request(
        url,
        data=data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "cardano-budget-proposal-fetcher/1.0",
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} fetching {url}: {exc.reason}") from exc
    except URLError as exc:
        raise RuntimeError(f"Unable to fetch {url}: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Response from {url} was not valid JSON") from exc


def fetch_json(path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    if query:
        url = f"{url}?{urlencode(query)}"
    return fetch_url_json(url)


def fetch_koios_json(path: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    return fetch_url_json(f"{KOIOS_BASE_URL}{path}", data=data)


def get_vote_id(slug: str) -> str:
    payload = fetch_json("/api/v0/votes/", {"slug": slug})
    votes = payload.get("data") or []
    if not votes:
        raise RuntimeError(f"No vote found for slug {slug!r}")
    vote_id = votes[0].get("_id")
    if not vote_id:
        raise RuntimeError(f"Vote payload for slug {slug!r} did not include an _id")
    return str(vote_id)


def as_decimal(value: Any) -> Decimal:
    if value is None or value == "":
        return Decimal("0")
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise RuntimeError(f"Budget value {value!r} is not numeric") from exc


def normalize_proposer_name(value: str) -> str:
    proposer_name = value.strip()
    return PROPOSER_NAME_NORMALIZATIONS.get(proposer_name, proposer_name)


def parse_proposal(raw: dict[str, Any]) -> Proposal:
    metadata = raw.get("metaData") or {}
    proposer_details = metadata.get("proposerDetails") or {}
    return Proposal(
        title=str(raw.get("title") or raw.get("name") or "Untitled Proposal").strip(),
        proposer_name=normalize_proposer_name(str(proposer_details.get("name") or "")),
        requested_budget_ada=as_decimal(metadata.get("totalBudget")),
        source="Ekklesia",
    )


def get_proposals(vote_id: str, pages: tuple[int, ...]) -> ProposalResult:
    proposals: list[Proposal] = []
    api_total: int | None = None

    for page in pages:
        payload = fetch_json(
            "/api/v0/proposals",
            {
                "vote": vote_id,
                "page": page,
                "limit": 10,
                "sort": "submittedAt",
                "direction": "desc",
                "status": "live",
            },
        )
        proposals.extend(parse_proposal(item) for item in payload.get("data", []))
        page_total = (payload.get("meta") or {}).get("total")
        if isinstance(page_total, int):
            api_total = page_total

    return ProposalResult(
        proposals=sorted(proposals, key=lambda item: item.requested_budget_ada, reverse=True),
        api_total=api_total,
    )


def get_current_epoch() -> int:
    payload = fetch_koios_json("/tip")
    if not payload:
        raise RuntimeError("Koios /tip did not return current chain tip data")
    return int(payload[0]["epoch_no"])


def proposed_epoch(raw: dict[str, Any]) -> int | None:
    epoch = raw.get("proposed_epoch")
    return int(epoch) if epoch is not None else None


def is_ncl_scoped_treasury_withdrawal(raw: dict[str, Any]) -> bool:
    if raw.get("proposal_type") != "TreasuryWithdrawals":
        return False
    epoch = proposed_epoch(raw)
    return epoch is not None and epoch >= NCL_TREASURY_WITHDRAWAL_START_EPOCH


def is_active_treasury_withdrawal(raw: dict[str, Any], current_epoch: int) -> bool:
    if not is_ncl_scoped_treasury_withdrawal(raw):
        return False
    if any(raw.get(key) is not None for key in ("ratified_epoch", "enacted_epoch", "dropped_epoch", "expired_epoch")):
        return False
    return int(raw.get("expiration") or 0) >= current_epoch


def parse_on_chain_proposal(raw: dict[str, Any], source: str) -> Proposal:
    metadata = raw.get("meta_json") or {}
    body = metadata.get("body") or {}
    authors = metadata.get("authors") or []
    title = str(body.get("title") or "Untitled On-Chain Proposal").strip()
    proposer_name = ON_CHAIN_PROPOSER_OVERRIDES.get(title) or ", ".join(
        str(author.get("name") or "").strip()
        for author in authors
        if str(author.get("name") or "").strip()
    )
    proposer_name = normalize_proposer_name(proposer_name)
    withdrawal_amount = sum(
        int(withdrawal.get("amount") or 0)
        for withdrawal in raw.get("withdrawal") or []
    )
    return Proposal(
        title=title,
        proposer_name=proposer_name,
        requested_budget_ada=Decimal(withdrawal_amount) / LOVELACE_PER_ADA,
        source=source,
    )


def passed_epoch(raw: dict[str, Any]) -> int | None:
    epochs = [
        int(raw[key])
        for key in ("ratified_epoch", "enacted_epoch")
        if raw.get(key) is not None
    ]
    return max(epochs) if epochs else None


def find_ncl_boundary_epoch(proposals: list[dict[str, Any]]) -> int:
    for proposal in proposals:
        if (
            proposal.get("proposal_id") == LAST_APPROVED_NCL_ACTION_ID
            or proposal.get("proposal_tx_hash") == LAST_APPROVED_NCL_TX_HASH
        ):
            return int(proposal["proposed_epoch"])
    raise RuntimeError(
        f"Could not find NCL action {LAST_APPROVED_NCL_ACTION_ID} in Koios proposal list"
    )


def is_ratified_treasury_withdrawal_after_ncl(raw: dict[str, Any], ncl_epoch: int) -> bool:
    if not is_ncl_scoped_treasury_withdrawal(raw):
        return False
    epoch = passed_epoch(raw)
    return epoch is not None and epoch > ncl_epoch


def get_on_chain_proposals() -> tuple[list[Proposal], list[Proposal]]:
    current_epoch = get_current_epoch()
    payload = fetch_koios_json("/proposal_list", {})
    ncl_epoch = find_ncl_boundary_epoch(payload)
    live = [
        parse_on_chain_proposal(item, "Live On-Chain")
        for item in payload
        if is_active_treasury_withdrawal(item, current_epoch)
    ]
    ratified = [
        parse_on_chain_proposal(item, "Ratified On-Chain")
        for item in payload
        if is_ratified_treasury_withdrawal_after_ncl(item, ncl_epoch)
        and not is_active_treasury_withdrawal(item, current_epoch)
    ]
    return live, ratified


def format_ada(value: Decimal) -> str:
    if value == value.to_integral_value():
        return f"{int(value):,}"
    return f"{value:,.6f}".rstrip("0").rstrip(".")


def wrap_cell(value: str, width: int) -> list[str]:
    return textwrap.wrap(value, width=width, break_long_words=False) or [""]


def print_aligned_table(proposals: list[Proposal]) -> None:
    terminal_width = max(shutil.get_terminal_size((220, 20)).columns, 220)
    number_width = max(2, len(str(len(proposals))))
    budget_width = max(len("Requested Budget (ADA)"), 16)
    source_width = max(len("Source"), *(len(item.source) for item in proposals))
    longest_proposer = max(
        (len(item.proposer_name) for item in proposals),
        default=len("Proposer Name"),
    )
    proposer_width = min(max(len("Proposer Name"), longest_proposer), 60)
    separators_width = 4 * 3
    title_width = max(
        len("Title"),
        terminal_width - number_width - budget_width - proposer_width - source_width - separators_width,
    )
    longest_title = max((len(item.title) for item in proposals), default=len("Title"))
    title_width = max(36, min(max(title_width, longest_title), 120))

    widths = (number_width, title_width, proposer_width, source_width, budget_width)
    header = (
        f"{'#':>{widths[0]}} | "
        f"{'Title':<{widths[1]}} | "
        f"{'Proposer Name':<{widths[2]}} | "
        f"{'Source':<{widths[3]}} | "
        f"{'Requested Budget (ADA)':>{widths[4]}}"
    )
    separator = "-+-".join("-" * width for width in widths)
    print(header)
    print(separator)

    for index, proposal in enumerate(proposals, start=1):
        columns = (
            [str(index)],
            wrap_cell(proposal.title, widths[1]),
            wrap_cell(proposal.proposer_name, widths[2]),
            [proposal.source],
            [format_ada(proposal.requested_budget_ada)],
        )
        row_height = max(len(column) for column in columns)
        for line_index in range(row_height):
            number = columns[0][line_index] if line_index < len(columns[0]) else ""
            title = columns[1][line_index] if line_index < len(columns[1]) else ""
            proposer = columns[2][line_index] if line_index < len(columns[2]) else ""
            source = columns[3][line_index] if line_index < len(columns[3]) else ""
            budget = columns[4][line_index] if line_index < len(columns[4]) else ""
            print(
                f"{number:>{widths[0]}} | "
                f"{title:<{widths[1]}} | "
                f"{proposer:<{widths[2]}} | "
                f"{source:<{widths[3]}} | "
                f"{budget:>{widths[4]}}"
            )


def print_markdown_table(proposals: list[Proposal]) -> None:
    print("| # | Title | Proposer Name | Source | Requested Budget (ADA) |")
    print("| ---: | --- | --- | --- | ---: |")
    for index, proposal in enumerate(proposals, start=1):
        title = proposal.title.replace("|", "\\|")
        proposer = proposal.proposer_name.replace("|", "\\|")
        source = proposal.source.replace("|", "\\|")
        print(f"| {index} | {title} | {proposer} | {source} | {format_ada(proposal.requested_budget_ada)} |")


def print_csv_table(proposals: list[Proposal]) -> None:
    writer = csv.writer(sys.stdout)
    writer.writerow(["#", "Title", "Proposer Name", "Source", "Requested Budget (ADA)"])
    for index, proposal in enumerate(proposals, start=1):
        writer.writerow(
            [
                index,
                proposal.title,
                proposal.proposer_name,
                proposal.source,
                str(proposal.requested_budget_ada),
            ]
        )


def proposal_to_dict(proposal: Proposal) -> dict[str, str | int | float]:
    budget = proposal.requested_budget_ada
    budget_value: int | float
    if budget == budget.to_integral_value():
        budget_value = int(budget)
    else:
        budget_value = float(budget)
    return {
        "title": proposal.title,
        "proposer_name": proposal.proposer_name,
        "source": proposal.source,
        "requested_budget_ada": budget_value,
    }


def write_json_payload(payload: Any, output: str | None) -> None:
    content = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        output_path = Path(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(f"{content}\n", encoding="utf-8")
    else:
        print(content)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Fetch Cardano Budget 2026 proposal pages 1 and 2 and sort by requested ADA budget."
    )
    parser.add_argument(
        "--format",
        choices=("table", "markdown", "csv", "json", "sankey-json"),
        default="table",
        help="Output format. Defaults to table.",
    )
    parser.add_argument(
        "--output",
        help="Optional file path for JSON or Sankey JSON output. Other formats print to stdout.",
    )
    args = parser.parse_args()

    vote_id = get_vote_id(VOTE_SLUG)
    result = get_proposals(vote_id, PAGES)
    live_on_chain_proposals, ratified_on_chain_proposals = get_on_chain_proposals()
    proposals = sorted(
        [*result.proposals, *live_on_chain_proposals, *ratified_on_chain_proposals],
        key=lambda item: item.requested_budget_ada,
        reverse=True,
    )

    if args.format == "json":
        write_json_payload([proposal_to_dict(proposal) for proposal in proposals], args.output)
    elif args.format == "sankey-json":
        write_json_payload(
            {
                "ncl_ada": int(NCL_ADA),
                "proposals": [proposal_to_dict(proposal) for proposal in proposals],
            },
            args.output,
        )
    elif args.format == "csv":
        print_csv_table(proposals)
    elif args.format == "markdown":
        print_markdown_table(proposals)
    else:
        print_aligned_table(proposals)

    if result.api_total is not None and len(result.proposals) != result.api_total:
        print(
            f"Warning: fetched {len(result.proposals)} Ekklesia proposals, but the API reports {result.api_total}.",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
