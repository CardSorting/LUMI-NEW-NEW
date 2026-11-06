import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

pkg_dir = os.path.dirname(os.path.abspath(__file__))
out_dir = os.path.join(pkg_dir, "slides")
os.makedirs(out_dir, exist_ok=True)

W, H = 1920, 1080


def get_font(size, bold=False, mono=False):
    candidates = []
    if mono:
        candidates = [
            "/System/Library/Fonts/SFNSMono.ttf",
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Supplemental/Courier New Bold.ttf"
            if bold
            else "/System/Library/Fonts/Supplemental/Courier New.ttf",
        ]
    elif bold:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
        ]
    else:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
        ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


font_tag = get_font(20, bold=True)
font_badge = get_font(17, bold=True, mono=True)
font_title = get_font(54, bold=True)
font_subtitle = get_font(25, bold=False)
font_card_title = get_font(24, bold=True)
font_card_sub = get_font(18, bold=True, mono=True)
font_card_body = get_font(19, bold=False)
font_mono = get_font(17, bold=False, mono=True)
font_mono_sm = get_font(16, bold=False, mono=True)
font_quote = get_font(30, bold=True)


def create_cyber_background(accent_color=(56, 189, 248), secondary_color=(16, 185, 129)):
    base = Image.new("RGBA", (W, H), (8, 12, 24, 255))
    draw = ImageDraw.Draw(base)

    for y in range(H):
        t = y / H
        r = int(7 + 8 * t)
        g = int(11 + 12 * t)
        b = int(22 + 20 * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b, 255))

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([-200, -200, 900, 700], fill=(*accent_color, 42))
    gdraw.ellipse([1100, 350, 2150, 1250], fill=(*secondary_color, 38))
    gdraw.ellipse([600, 100, 1400, 800], fill=(139, 92, 246, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=95))
    base = Image.alpha_composite(base, glow)

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grdraw = ImageDraw.Draw(grid)
    step = 60
    for x in range(0, W, step):
        grdraw.line([(x, 0), (x, H)], fill=(148, 163, 184, 12), width=1)
    for y in range(0, H, step):
        grdraw.line([(0, y), (W, y)], fill=(148, 163, 184, 12), width=1)

    grdraw.line([(80, 68), (W - 80, 68)], fill=(*accent_color, 90), width=1)
    grdraw.line([(80, H - 72), (W - 80, H - 72)], fill=(51, 65, 85, 160), width=1)

    base = Image.alpha_composite(base, grid)
    return base


def draw_glass_card(
    img,
    x,
    y,
    w,
    h,
    fill=(15, 23, 42, 215),
    outline=(56, 189, 248, 130),
    radius=16,
    top_bar_color=None,
):
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle(
        [x, y, x + w, y + h], radius=radius, fill=fill, outline=outline, width=2
    )
    if top_bar_color:
        odraw.rounded_rectangle(
            [x + 2, y + 2, x + w - 2, y + 8],
            radius=4,
            fill=top_bar_color,
        )
    return Image.alpha_composite(img, overlay)


def draw_pill(
    draw,
    x,
    y,
    text,
    fg=(16, 185, 129, 255),
    bg=(6, 78, 59, 200),
    border=(16, 185, 129, 180),
    font=font_badge,
    pad_x=14,
    pad_y=7,
):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pw = tw + pad_x * 2
    ph = th + pad_y * 2 + 2
    draw.rounded_rectangle(
        [x, y, x + pw, y + ph], radius=ph // 2, fill=bg, outline=border, width=1
    )
    draw.text((x + pad_x, y + pad_y), text, fill=fg, font=font)
    return pw


def draw_check(draw, x, y, color=(16, 185, 129, 255), size=14):
    # Draw a crisp vector checkmark
    draw.line(
        [(x, y + size * 0.55), (x + size * 0.38, y + size * 0.9), (x + size, y + size * 0.15)],
        fill=color,
        width=3,
    )


def draw_arrow_bullet(draw, x, y, color=(56, 189, 248, 255), size=10):
    draw.polygon(
        [(x, y), (x + size, y + size * 0.6), (x, y + size * 1.2)],
        fill=color,
    )


def wrap_text_px(draw, text, font, max_width_px):
    words = text.split()
    lines = []
    cur = []
    for w in words:
        cur.append(w)
        bbox = draw.textbbox((0, 0), " ".join(cur), font=font)
        if (bbox[2] - bbox[0]) > max_width_px and len(cur) > 1:
            cur.pop()
            lines.append(" ".join(cur))
            cur = [w]
    if cur:
        lines.append(" ".join(cur))
    return lines


def draw_header(draw, super_tag, title, subtitle, phase_badge="LUMI v26.5.0 // LAUNCH"):
    draw.text((100, 88), super_tag, fill=(56, 189, 248, 255), font=font_tag)
    bbox = draw.textbbox((0, 0), phase_badge, font=font_badge)
    pw = (bbox[2] - bbox[0]) + 28
    draw_pill(
        draw,
        W - 100 - pw,
        82,
        phase_badge,
        fg=(56, 189, 248, 255),
        bg=(15, 23, 42, 230),
        border=(56, 189, 248, 180),
    )
    draw.text((100, 122), title, fill=(255, 255, 255, 255), font=font_title)
    draw.text((100, 192), subtitle, fill=(148, 163, 184, 255), font=font_subtitle)


def draw_footer(
    draw,
    left_text,
    right_text="455 Swarm Tests | 465 Execution Tests | 32 Webview Tests | 0 Errors",
):
    draw.text((100, 1022), left_text, fill=(100, 116, 139, 255), font=font_mono_sm)
    bbox = draw.textbbox((0, 0), right_text, font=font_mono_sm)
    rw = bbox[2] - bbox[0]
    draw.text((W - 100 - rw, 1022), right_text, fill=(16, 185, 129, 230), font=font_mono_sm)


# Save Base Background
base_bg = create_cyber_background()
base_bg.convert("RGB").save(os.path.join(out_dir, "background.jpg"), quality=95)


# ==============================================================================
# SLIDE 1: Introducing Agent Swarm & The Legion (LUMI v26.5.0)
# ==============================================================================
def render_slide1():
    img = create_cyber_background((56, 189, 248), (16, 185, 129))
    draw = ImageDraw.Draw(img)

    draw_header(
        draw,
        "LUMI MULTI-AGENT ORCHESTRATION // PHASES 1 TO 11 COMPLETE",
        "AGENT SWARM & THE LEGION",
        "Transforming single-stream prompts into an autonomous, self-healing multi-agent engineering organization.",
        "RELEASE v26.5.0",
    )

    pillars = [
        (
            "01 // HIERARCHICAL DEFER & RESUME",
            "HierarchicalDeferCoordinator.ts",
            (56, 189, 248),
            "Suspend parent & multi-level child trees at safe cooperative execution boundaries—never mid-tool or mid-write.",
            [
                "Cycle-safe 4-level BFS hierarchy barrier",
                "Durable control inboxes & step receipts",
                "Exact checkpoint resumption without replay",
                "Parent acceptingNewWork conflict gating",
            ],
            "ADR-0002 / ADR-0004",
        ),
        (
            "02 // CRITICAL COMPLETION REVIEW",
            "CriticalCompletionReview.ts",
            (245, 158, 11),
            "Subject completed tasks to one bounded, evidence-based adversarial review before final completion settlement.",
            [
                "Separates verified_defect vs unverified_concern",
                "4-way gate: ACCEPT / NOTE / REMEDIATE / ESCALATE",
                "Strict 1+1 review & remediation cycle bound",
                "Auto-spawns Remedial Legion specialists on defects",
            ],
            "ADR-0005 / PM-007",
        ),
        (
            "03 // THE LEGION (DEFAULT ON)",
            "LegionCoordinator.ts + LegionAgentHost.ts",
            (16, 185, 129),
            "Deterministic multi-signal task classifier that forms specialist squads across dependency-ordered DAG stages.",
            [
                "10 specialist archetypes across 3 execution stages",
                "Strict file-reservation partitioning (file_res:*)",
                "Bounded 1-retry slot failover (max 2 attempts)",
                "Consolidated synthesis & durable operation receipts",
            ],
            "ADR-0008 / ADR-0012",
        ),
    ]

    card_w = 546
    card_h = 560
    card_y = 260
    for i, (ptitle, pfile, color, desc, bullets, adr_tag) in enumerate(pillars):
        cx = 100 + i * (card_w + 40)
        img = draw_glass_card(
            img,
            cx,
            card_y,
            card_w,
            card_h,
            fill=(15, 23, 42, 225),
            outline=(*color, 165),
            top_bar_color=(*color, 255),
        )
        draw = ImageDraw.Draw(img)

        draw.text((cx + 28, card_y + 30), ptitle, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((cx + 28, card_y + 66), pfile, fill=(*color, 255), font=font_card_sub)

        lines = wrap_text_px(draw, desc, font_card_body, card_w - 56)
        for li, line in enumerate(lines):
            draw.text(
                (cx + 28, card_y + 110 + li * 27),
                line,
                fill=(203, 213, 225, 255),
                font=font_card_body,
            )

        draw.line(
            [(cx + 28, card_y + 215), (cx + card_w - 28, card_y + 215)],
            fill=(51, 65, 85, 200),
            width=1,
        )

        for bi, btext in enumerate(bullets):
            by = card_y + 240 + bi * 54
            draw.ellipse([cx + 28, by + 6, cx + 40, by + 18], fill=(*color, 255))
            draw.text((cx + 52, by), btext, fill=(226, 232, 240, 255), font=font_card_body)

        draw_pill(
            draw,
            cx + 28,
            card_y + 490,
            f"VERIFIED // {adr_tag}",
            fg=(*color, 255),
            bg=(15, 23, 42, 240),
            border=(*color, 150),
        )

    img = draw_glass_card(
        img,
        100,
        850,
        1720,
        130,
        fill=(15, 23, 42, 235),
        outline=(56, 189, 248, 130),
    )
    draw = ImageDraw.Draw(img)
    draw.text(
        (140, 875),
        "UNIFIED PERSISTENCE SUBSTRATE: BufferedDbPool (SQLite WAL + Shadow Overlay Isolation)",
        fill=(56, 189, 248, 255),
        font=font_card_title,
    )
    draw.text(
        (140, 918),
        "Zero external message brokers required. All streams, control inboxes, file locks, and knowledge heuristics persist atomically in SQLite.",
        fill=(203, 213, 225, 255),
        font=font_card_body,
    )

    draw_footer(draw, "SCENE 01 // THREE ORCHESTRATION ENGINES, ONE DETERMINISTIC SUBSTRATE")
    img.convert("RGB").save(os.path.join(out_dir, "slide1.jpg"), quality=95)


# ==============================================================================
# SLIDE 2: Orchestrator Conductor & 10 Specialist Archetypes
# ==============================================================================
def render_slide2():
    img = create_cyber_background((16, 185, 129), (56, 189, 248))
    draw = ImageDraw.Draw(img)

    draw_header(
        draw,
        "PHASES 6 & 7 // AUTONOMOUS CONDUCTOR & REAL-TIME STREAMING",
        "ORCHESTRATOR CONDUCTOR & THE LEGION",
        "Auto-approved engage_swarm tool, 10 specialist archetypes, 3-stage DAG pipeline, and live chat progress cards.",
        "ADR-0012 & ADR-0013",
    )

    # Left Column: Conductor Tool & DAG Stages
    img = draw_glass_card(
        img,
        100,
        255,
        1040,
        725,
        fill=(15, 23, 42, 225),
        outline=(56, 189, 248, 160),
        top_bar_color=(56, 189, 248, 255),
    )
    draw = ImageDraw.Draw(img)
    draw.text(
        (135, 285),
        "ORCHESTRATOR CONDUCTOR PIPELINE",
        fill=(255, 255, 255, 255),
        font=font_card_title,
    )
    draw.text(
        (135, 320),
        "engage_swarm(objective, strategy, preferred_roles, max_specialists=1..8)",
        fill=(56, 189, 248, 255),
        font=font_card_sub,
    )

    stages = [
        (
            "STAGE 1: LEAD & RECON (leadAndRecon)",
            (56, 189, 248),
            "Systems Architect + Codebase Researcher + Data Migration Specialist",
            "Maps symbol graph, audits invariants, partitions target file locks, and seeds stage handoffs.",
        ),
        (
            "STAGE 2: PARALLEL EXECUTION (parallelExecution)",
            (16, 185, 129),
            "Implementation Engineer + UX & Ergonomics + Performance Profiler",
            "Executes isolated LegionAgentHost loops via sandboxed LegionToolAdapter without file conflicts.",
        ),
        (
            "STAGE 3: VERIFICATION & HARDENING (verificationAndHardening)",
            (245, 158, 11),
            "Verification QA + Resilience Hardener + Security Auditor + Doc Synth",
            "Validates contracts, tests failure modes, audits security boundaries, and synthesizes handoff.",
        ),
    ]

    for si, (stitle, scolor, sroles, sdesc) in enumerate(stages):
        sy = 372 + si * 154
        img = draw_glass_card(
            img,
            135,
            sy,
            970,
            132,
            fill=(30, 41, 59, 230),
            outline=(*scolor, 150),
            radius=12,
        )
        draw = ImageDraw.Draw(img)
        draw.text((160, sy + 16), stitle, fill=(*scolor, 255), font=font_card_title)
        draw.text((160, sy + 52), f"Archetypes: {sroles}", fill=(255, 255, 255, 255), font=font_mono)
        draw.text((160, sy + 86), sdesc, fill=(148, 163, 184, 255), font=font_card_body)

    strategies = [
        "adaptive",
        "tactical_strike",
        "balanced_squad",
        "full_legion",
        "verification_heavy",
    ]
    draw.text((135, 855), "STRATEGIES:", fill=(148, 163, 184, 255), font=get_font(18, bold=True))
    px = 270
    for strat in strategies:
        w = draw_pill(
            draw,
            px,
            848,
            strat,
            fg=(16, 185, 129, 255),
            bg=(6, 78, 59, 180),
            border=(16, 185, 129, 150),
            font=get_font(15, bold=True, mono=True),
            pad_x=11,
            pad_y=6,
        )
        px += w + 10

    features_bottom = [
        (135, "Auto-Approved Dispatch"),
        (435, "User Steering Abort (activeLegionController)"),
        (865, "Categorized Failover"),
    ]
    for fx, ftext in features_bottom:
        draw_check(draw, fx, 916, color=(16, 185, 129, 255), size=15)
        draw.text((fx + 24, 912), ftext, fill=(226, 232, 240, 255), font=get_font(18, bold=False))

    # Right Column: Live Progress Streaming & 10 Specialist Roster
    img = draw_glass_card(
        img,
        1180,
        255,
        640,
        725,
        fill=(15, 23, 42, 225),
        outline=(16, 185, 129, 160),
        top_bar_color=(16, 185, 129, 255),
    )
    draw = ImageDraw.Draw(img)
    draw.text(
        (1215, 285),
        "LIVE STREAMING PROGRESS CARDS",
        fill=(255, 255, 255, 255),
        font=font_card_title,
    )
    draw.text(
        (1215, 320),
        "formatLegionProgressMessage() -> Chat Feed",
        fill=(16, 185, 129, 255),
        font=font_card_sub,
    )

    chat_events = [
        ("STAGE STARTED", "Stage 1/3: Lead & Recon (2 specialists)", (56, 189, 248)),
        ("MEMBER COMPLETED", "Systems Architect settled (receipt #01)", (16, 185, 129)),
        ("BOUNDED FAILOVER", "Slot rerouted -> Resilience Hardener (1/2)", (245, 158, 11)),
        ("FORMATION SETTLED", "Synthesized <specialist_handoff status='completed'>", (16, 185, 129)),
    ]
    for ei, (etag, edesc, ecolor) in enumerate(chat_events):
        ey = 370 + ei * 84
        img = draw_glass_card(
            img,
            1215,
            ey,
            570,
            70,
            fill=(24, 33, 52, 240),
            outline=(*ecolor, 140),
            radius=10,
        )
        draw = ImageDraw.Draw(img)
        draw.ellipse([1235, ey + 15, 1247, ey + 27], fill=(*ecolor, 255))
        draw.text((1256, ey + 11), etag, fill=(*ecolor, 255), font=font_badge)
        draw.text((1235, ey + 39), edesc, fill=(226, 232, 240, 255), font=font_mono_sm)

    draw.text(
        (1215, 725),
        "10 SPECIALIST ARCHETYPES",
        fill=(255, 255, 255, 255),
        font=font_card_title,
    )
    roles = [
        "systems_architect",
        "codebase_researcher",
        "implementation_engineer",
        "resilience_hardener",
        "ux_ergonomics",
        "verification_qa",
        "security_auditor",
        "performance_profiler",
        "data_migration",
        "doc_synthesizer",
    ]
    for ri, role in enumerate(roles):
        rx = 1215 + (ri % 2) * 290
        ry = 768 + (ri // 2) * 38
        draw.text((rx, ry), f"• {role}", fill=(148, 163, 184, 255), font=font_mono_sm)

    draw_footer(
        draw,
        "SCENE 02 // ORCHESTRATOR CONDUCTOR, 10 SPECIALISTS & DEPENDENCY-ORDERED DAG STAGES",
    )
    img.convert("RGB").save(os.path.join(out_dir, "slide2.jpg"), quality=95)


# ==============================================================================
# SLIDE 3: Self-Healing Streams & Multi-Tier Terminal Defense (Phases 8, 9, 10)
# ==============================================================================
def render_slide3():
    img = create_cyber_background((245, 158, 11), (56, 189, 248))
    draw = ImageDraw.Draw(img)

    draw_header(
        draw,
        "PHASES 8, 9 & 10 // TRANSPORT RESILIENCE & TERMINAL POLICY ENGINE",
        "SELF-HEALING STREAMS & TERMINAL DEFENSE",
        "Eliminating streaming tool corruption, shell heredoc deadlocks, raw file dumps, and token budget starvation.",
        "ADR-0014 TO ADR-0016",
    )

    cards = [
        (
            "PHASE 8 // STREAM SELF-HEALING",
            "StreamResponseHandler.ts + openai-codex.ts",
            (56, 189, 248),
            [
                (
                    "Snapshot Offset Slicing",
                    "toolCallDelta() slices trailing suffixes and drops duplicate done snapshots.",
                ),
                (
                    "Interleaved Identity Maps",
                    "Preserves toolCallId and toolName across interleaved Responses API chunks.",
                ),
                (
                    "extractJsonRoots() Parser",
                    "State-machine scanner heals duplicate JSON roots and string braces.",
                ),
                (
                    "Transport Circuit-Breaker",
                    "Typed ToolArgumentError sets safeToRetry: false to halt futile retries.",
                ),
            ],
            "PM-015 RESOLVED // 50 Streaming Tests",
        ),
        (
            "PHASE 9 // HEREDOC DEFENSE",
            "heredocPolicy.ts + VscodeTerminalProcess.ts",
            (245, 158, 11),
            [
                (
                    "Shell Token-Aware Scanner",
                    "findTopLevelHeredocs() tracks quotes, escapes & $((...)) bit-shifts.",
                ),
                (
                    "Redirection Interception",
                    "detectHeredocFileRedirection() blocks cat <<'EOF' > file before UI asks.",
                ),
                (
                    "Deadlock Circuit-Breaker",
                    "VscodeTerminalProcess refuses multiline heredocs without fallback.",
                ),
                (
                    "1:1 Prompt Parity",
                    "Injects LEGION_CORE_RULES into every specialist host mandating write_to_file.",
                ),
            ],
            "PM-016 RESOLVED // 33 Heredoc Tests",
        ),
        (
            "PHASE 10 // FILE READ & BUDGETS",
            "terminalFileReadPolicy.ts + LegionAgentHost.ts",
            (16, 185, 129),
            [
                (
                    "Compound Pipeline Parser",
                    "detectTerminalFileRead() intercepts unpiped cat, head, tail, more & less.",
                ),
                (
                    "Smart Whitelisting",
                    "Permits cat file | grep pipelines, /proc/* probes & tail -f streaming.",
                ),
                (
                    "Token Starvation Fix",
                    "Removed 100k cumulative token cap that starved multi-turn specialists.",
                ),
                (
                    "Universal Guard Wiring",
                    "Enforced in ExecuteCommand, UniversalGuard, FluidPolicy & ToolValidator.",
                ),
            ],
            "PM-017 RESOLVED // 67 File Read Tests",
        ),
    ]

    card_w = 546
    card_h = 700
    card_y = 265
    for i, (ctitle, csub, color, items, footer_badge) in enumerate(cards):
        cx = 100 + i * (card_w + 40)
        img = draw_glass_card(
            img,
            cx,
            card_y,
            card_w,
            card_h,
            fill=(15, 23, 42, 228),
            outline=(*color, 165),
            top_bar_color=(*color, 255),
        )
        draw = ImageDraw.Draw(img)
        draw.text((cx + 28, card_y + 28), ctitle, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((cx + 28, card_y + 62), csub, fill=(*color, 255), font=get_font(16, bold=True, mono=True))

        for ii, (ihdr, ibody) in enumerate(items):
            iy = card_y + 112 + ii * 125
            draw.rounded_rectangle(
                [cx + 28, iy, cx + card_w - 28, iy + 110],
                radius=10,
                fill=(30, 41, 59, 210),
                outline=(51, 65, 85, 180),
            )
            draw_arrow_bullet(draw, cx + 44, iy + 18, color=(*color, 255), size=10)
            draw.text(
                (cx + 62, iy + 12),
                ihdr,
                fill=(*color, 255),
                font=get_font(19, bold=True),
            )
            wlines = wrap_text_px(draw, ibody, get_font(17), card_w - 88)
            for wl_i, wl in enumerate(wlines[:2]):
                draw.text(
                    (cx + 44, iy + 44 + wl_i * 25),
                    wl,
                    fill=(203, 213, 225, 255),
                    font=get_font(17),
                )

        draw_pill(
            draw,
            cx + 28,
            card_y + 635,
            footer_badge,
            fg=(*color, 255),
            bg=(15, 23, 42, 245),
            border=(*color, 160),
        )

    draw_footer(
        draw,
        "SCENE 03 // ZERO STREAM CORRUPTION, ZERO TERMINAL HEREDOC DEADLOCKS, ZERO TOKEN STARVATION",
    )
    img.convert("RGB").save(os.path.join(out_dir, "slide3.jpg"), quality=95)


# ==============================================================================
# SLIDE 4: Phase 11 Deep-Dive (Knowledge, Integrity, Supervision & Handoffs)
# ==============================================================================
def render_slide4():
    img = create_cyber_background((139, 92, 246), (16, 185, 129))
    draw = ImageDraw.Draw(img)

    draw_header(
        draw,
        "PHASE 11 // NEXT-GEN SWARM INTELLIGENCE & CRYPTOGRAPHIC HARDENING",
        "DYNAMIC KNOWLEDGE, INTEGRITY & FENCING",
        "Four foundational breakthroughs shipped in LUMI v26.5.0 (ADR-0017 through ADR-0020).",
        "PHASE 11 // NEW",
    )

    quads = [
        (
            "ADR-0017 // DYNAMIC PROJECT KNOWLEDGE & BLACKBOARD",
            "LegionKnowledge.ts + BufferedDbPool.ts",
            (56, 189, 248),
            [
                "SHA-256 Workspace Scoping: legionWorkspaceScope(cwd) isolates heuristics.",
                "30-Day TTL & Pruning: max 20 reusable observations (1..500 chars) per scope.",
                "Multi-Tier Credential Scrubbing: blocks GitHub, OpenAI, AWS AKIA, JWT & URL secrets.",
                "Swarm Blackboard: shares verified observations across stages & formations.",
            ],
        ),
        (
            "ADR-0018 // WORKSPACE ENVIRONMENT INTEGRITY",
            "EnvironmentIntegrity.ts + ApplyPatch / WriteToFile",
            (16, 185, 129),
            [
                "Manifest Fingerprinting: SHA-256 digest of size, mtimeMs & ctimeMs on manifests.",
                "Reactive Cache Invalidation: auto-invalidates on package.json, Cargo.toml, .nvmrc edits.",
                "Generational Concurrency Probes: 3-retry generation counter prevents race conditions.",
                "WeakRef Instance Registry & realpath PATH-shadowing detection.",
            ],
        ),
        (
            "ADR-0019 // TERMINAL SUPERVISION & DB SHADOW RETENTION",
            "SupervisedShell.ts + ActionExecutionRegistry.ts + BufferedDbPool.ts",
            (245, 158, 11),
            [
                "Post-Spawn Observation Isolation: stream errors never falsify running process state.",
                "Strict commandOutcome: only exitCode === 0 marks completed; missing stays unconfirmed.",
                "View Epoch Ownership Fencing & Replay Protection across chat replacements.",
                "ShadowCommitError Retention: retains uncommitted DB shadows & guards stop().",
            ],
        ),
        (
            "ADR-0020 // ROBUST HANDOFFS, RESERVATIONS & SKILLS",
            "LegionHandoff.ts + LegionPipelineRunner.ts + skills.ts",
            (168, 85, 247),
            [
                "Surrogate-Safe 12 KB XML Truncation: binary-search UTF-8 cap without splitting pairs.",
                "Two-Phase Formation Reservations: prevents duplicate parallel team dispatches.",
                "Unsettled Reconciliation: needs_reconciliation halts duplicate failovers on DB fault.",
                "Skills Hardening: AbortSignal I/O, frontmatter re-validation & untrusted framing.",
            ],
        ),
    ]

    qw = 840
    qh = 335
    for qi, (qtitle, qsub, qcolor, qbullets) in enumerate(quads):
        qx = 100 + (qi % 2) * (qw + 40)
        qy = 265 + (qi // 2) * (qh + 32)
        img = draw_glass_card(
            img,
            qx,
            qy,
            qw,
            qh,
            fill=(15, 23, 42, 230),
            outline=(*qcolor, 165),
            top_bar_color=(*qcolor, 255),
        )
        draw = ImageDraw.Draw(img)
        draw.text((qx + 30, qy + 24), qtitle, fill=(255, 255, 255, 255), font=get_font(22, bold=True))
        draw.text((qx + 30, qy + 56), qsub, fill=(*qcolor, 255), font=font_card_sub)

        for bi, b in enumerate(qbullets):
            by = qy + 102 + bi * 52
            draw.ellipse([qx + 30, by + 7, qx + 42, by + 19], fill=(*qcolor, 255))
            draw.text((qx + 56, by), b, fill=(226, 232, 240, 255), font=get_font(19))

    draw_footer(
        draw,
        "SCENE 04 // PHASE 11: SHA-256 SCOPED BLACKBOARD, MANIFEST FINGERPRINTING & SEMANTIC FENCING",
    )
    img.convert("RGB").save(os.path.join(out_dir, "slide4.jpg"), quality=95)


# ==============================================================================
# SLIDE 5: Empirically Verified at Scale
# ==============================================================================
def render_slide5():
    img = create_cyber_background((16, 185, 129), (56, 189, 248))
    draw = ImageDraw.Draw(img)

    draw_header(
        draw,
        "EMPIRICAL VERIFICATION // REAL SQLITE & MULTI-PROCESS CONCURRENCY PROOFS",
        "BUILT FOR PRODUCTION RELIABILITY",
        "Every architectural claim in the Agent Swarm & Legion wiki is backed by automated verification proofs.",
        "952 PASSING TESTS",
    )

    metrics = [
        ("455", "Swarm Suite Tests", "npm run test:swarm", (16, 185, 129)),
        ("465", "Execution Suite Tests", "npm run test:execution", (56, 189, 248)),
        ("32", "Webview UI Tests", "vitest FeatureSettings", (168, 85, 247)),
        ("20", "Architecture ADRs", "ADR-0001 .. ADR-0020", (245, 158, 11)),
        ("19", "Post-Mortem Proofs", "PM-001 .. PM-019", (56, 189, 248)),
    ]

    mw = 320
    mh = 250
    my = 265
    for mi, (mval, mlabel, msub, mcol) in enumerate(metrics):
        mx = 100 + mi * (mw + 30)
        img = draw_glass_card(
            img,
            mx,
            my,
            mw,
            mh,
            fill=(15, 23, 42, 235),
            outline=(*mcol, 170),
            top_bar_color=(*mcol, 255),
        )
        draw = ImageDraw.Draw(img)
        draw.text((mx + 28, my + 34), mval, fill=(*mcol, 255), font=get_font(58, bold=True))
        draw.text((mx + 28, my + 120), mlabel, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((mx + 28, my + 162), msub, fill=(148, 163, 184, 255), font=font_mono_sm)
        draw_check(draw, mx + 28, my + 202, color=(16, 185, 129, 255), size=14)
        draw.text((mx + 50, my + 198), "100% PASSING", fill=(16, 185, 129, 255), font=font_badge)

    img = draw_glass_card(
        img,
        100,
        550,
        1720,
        265,
        fill=(15, 23, 42, 235),
        outline=(56, 189, 248, 160),
    )
    draw = ImageDraw.Draw(img)
    draw.text(
        (140, 582),
        "“Autonomous scale without chaos: cooperative suspension, adversarial review, and specialist orchestration.”",
        fill=(255, 255, 255, 255),
        font=font_quote,
    )
    draw.text(
        (140, 642),
        "• Real-SQLite Multi-Process Concurrency Worker Proofs (legion-claim-worker.cjs) + Q1–Q8 Diagnostic SQLite Cookbook",
        fill=(16, 185, 129, 255),
        font=get_font(23, bold=False),
    )
    draw.text(
        (140, 686),
        "• 1,765 Files Biome Linted (0 Errors) | Zero TypeScript Errors (Root + Webview) | One-Click Presets in Settings",
        fill=(203, 213, 225, 255),
        font=get_font(23, bold=False),
    )
    draw.text(
        (140, 735),
        "• Complete Knowledge Base Wiki in agentswarm/: 3 Papers, 4 Maintainer Guides, 8 Playbooks, 20 ADRs, 19 Post-Mortems",
        fill=(56, 189, 248, 255),
        font=font_card_sub,
    )

    bot_cards = [
        (
            "1-CLICK WORKFLOW PRESETS",
            "Standard | Review Only | Defer Only | Legion Only | Full Swarm + Legion",
        ),
        (
            "ORCHESTRATOR CONDUCTOR",
            "Auto-approved engage_swarm tool with real-time chat progress cards",
        ),
        (
            "CRYPTOGRAPHIC HARDENING",
            "SHA-256 Knowledge Scope, Manifest Fingerprints & 12 KB XML Handoffs",
        ),
    ]
    for bi, (bt, bs) in enumerate(bot_cards):
        bx = 100 + bi * (553 + 30)
        by = 845
        img = draw_glass_card(
            img, bx, by, 553, 130, fill=(30, 41, 59, 230), outline=(16, 185, 129, 140)
        )
        draw = ImageDraw.Draw(img)
        draw.text((bx + 28, by + 24), bt, fill=(255, 255, 255, 255), font=get_font(22, bold=True))
        wlines = wrap_text_px(draw, bs, get_font(18), 553 - 56)
        for wli, wl in enumerate(wlines[:2]):
            draw.text(
                (bx + 28, by + 62 + wli * 26),
                wl,
                fill=(148, 163, 184, 255),
                font=get_font(18),
            )

    draw_footer(draw, "SCENE 05 // LUMI v26.5.0 AGENT SWARM & THE LEGION — READY FOR LAUNCH")
    img.convert("RGB").save(os.path.join(out_dir, "slide5.jpg"), quality=95)


# ==============================================================================
# THUMBNAIL: High-Impact Product Launch Poster
# ==============================================================================
def render_thumbnail():
    img = create_cyber_background((56, 189, 248), (16, 185, 129))
    draw = ImageDraw.Draw(img)

    draw_pill(
        draw,
        100,
        100,
        "LUMI v26.5.0 // PRODUCT LAUNCH DEMO",
        fg=(15, 23, 42, 255),
        bg=(16, 185, 129, 255),
        border=(16, 185, 129, 255),
        font=get_font(24, bold=True),
    )

    draw.text((100, 175), "AGENT SWARM", fill=(255, 255, 255, 255), font=get_font(86, bold=True))
    draw.text((100, 278), "& THE LEGION", fill=(56, 189, 248, 255), font=get_font(86, bold=True))

    draw.text(
        (100, 395),
        "Autonomous Multi-Agent Orchestration, Self-Healing Streams & Cryptographic Workspace Integrity",
        fill=(226, 232, 240, 255),
        font=get_font(30, bold=False),
    )

    img = draw_glass_card(
        img,
        100,
        485,
        1720,
        340,
        fill=(15, 23, 42, 240),
        outline=(56, 189, 248, 180),
        top_bar_color=(56, 189, 248, 255),
    )
    draw = ImageDraw.Draw(img)

    t_metrics = [
        ("10", "Specialist Archetypes", "3-Stage DAG Pipeline", (16, 185, 129)),
        ("11", "Engineering Phases", "ADR-0001 .. ADR-0020", (56, 189, 248)),
        ("952", "Passing Automated Tests", "Swarm + Exec + Webview", (245, 158, 11)),
        ("0", "Deadlocks & Leaks", "Heredoc & Secret Guards", (168, 85, 247)),
    ]
    for mi, (mv, ml, ms, mcol) in enumerate(t_metrics):
        mx = 145 + mi * 425
        draw.text((mx, 535), mv, fill=(*mcol, 255), font=get_font(74, bold=True))
        draw.text((mx, 640), ml, fill=(255, 255, 255, 255), font=get_font(26, bold=True))
        draw.text((mx, 682), ms, fill=(148, 163, 184, 255), font=font_mono)
        if mi < 3:
            draw.line([(mx + 385, 535), (mx + 385, 760)], fill=(51, 65, 85, 220), width=2)

    pills = [
        "engage_swarm Conductor",
        "Hierarchical Defer",
        "Critical Review",
        "SHA-256 Blackboard",
        "Manifest Fingerprinting",
        "12 KB XML Handoffs",
    ]
    px = 100
    for p in pills:
        w = draw_pill(
            draw,
            px,
            875,
            p,
            fg=(56, 189, 248, 255),
            bg=(15, 23, 42, 235),
            border=(56, 189, 248, 140),
            font=get_font(17, bold=True, mono=True),
            pad_x=14,
            pad_y=7,
        )
        px += w + 16

    draw_footer(draw, "LUMI v26.5.0 // FULL HD FEATURE LAUNCH DEMO // AGENTSWARM WORKSPACE")

    thumb_path = os.path.join(pkg_dir, "thumbnail.png")
    img.convert("RGB").save(thumb_path, quality=95)
    print(f"Thumbnail saved to {thumb_path}")


print("Rendering all 5 slides and launch thumbnail...")
render_slide1()
render_slide2()
render_slide3()
render_slide4()
render_slide5()
render_thumbnail()
print("All slides and thumbnail rendered successfully!")
