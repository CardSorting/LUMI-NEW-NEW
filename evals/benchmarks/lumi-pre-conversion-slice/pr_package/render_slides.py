import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out_dir = "evals/benchmarks/lumi-pre-conversion-slice/pr_package/slides"
os.makedirs(out_dir, exist_ok=True)

bg_path = os.path.join(out_dir, "background.jpg")
base_bg = Image.open(bg_path).convert("RGBA").resize((1920, 1080))

# Fonts
def get_font(size, bold=False):
    try:
        if bold:
            return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size)
        else:
            return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", size)
    except Exception:
        return ImageFont.load_default()

font_tag = get_font(22, bold=True)
font_title = get_font(56, bold=True)
font_subtitle = get_font(26, bold=False)
font_card_title = get_font(26, bold=True)
font_card_body = get_font(20, bold=False)
font_metric_val = get_font(42, bold=True)
font_metric_label = get_font(20, bold=False)
font_quote = get_font(38, bold=True)

# Helper: Draw rounded glass card
def draw_glass_card(draw, x, y, w, h, fill=(15, 23, 42, 210), outline=(56, 189, 248, 120), radius=16):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill, outline=outline, width=2)

# ==============================================================================
# SLIDE 1: The Invisible Machinery
# ==============================================================================
def render_slide1():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 120))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    # Top Tag
    draw.text((120, 100), "LUMI RESEARCH // COMMISSION REPORT", fill=(56, 189, 248, 255), font=font_tag)
    
    # Title & Subtitle
    draw.text((120, 140), "THE ENGINEERING PEOPLE NEVER SEE", fill=(255, 255, 255, 255), font=font_title)
    draw.text((120, 220), "Software infrastructure is experienced by millions who will never inspect its code.", fill=(148, 163, 184, 255), font=font_subtitle)

    # 3 Pillars Cards
    cards = [
        ("Fluid Human Flow", "Developers should focus on creative thought, not wait for their tools. Prompt response preserves cognition."),
        ("Invisible Dependability", "The most resilient infrastructure operates silently, absorbing complexity before reaching human attention."),
        ("Frictionless Operation", "Every unnecessary millisecond inside a harness is a barrier between intent and execution.")
    ]
    card_w = 520
    card_h = 320
    card_y = 360
    for i, (title, desc) in enumerate(cards):
        cx = 120 + i * (card_w + 60)
        draw_glass_card(draw, cx, card_y, card_w, card_h, fill=(15, 23, 42, 220), outline=(16, 185, 129, 140))
        # Icon dot
        draw.ellipse([cx + 32, card_y + 36, cx + 52, card_y + 56], fill=(16, 185, 129, 255))
        draw.text((cx + 68, card_y + 32), title, fill=(255, 255, 255, 255), font=font_card_title)
        
        # Word wrapped text
        words = desc.split()
        lines = []
        cur = []
        for w in words:
            cur.append(w)
            if len(" ".join(cur)) > 34:
                cur.pop()
                lines.append(" ".join(cur))
                cur = [w]
        if cur: lines.append(" ".join(cur))
        
        for li, line in enumerate(lines):
            draw.text((cx + 32, card_y + 110 + li * 34), line, fill=(203, 213, 225, 255), font=font_card_body)

    # Footer
    draw.text((120, 960), "Lead Investigator: Deputy Gemini | Executive Chair: MAJO | Principal: EGG", fill=(100, 116, 139, 255), font=font_tag)
    img.convert("RGB").save(os.path.join(out_dir, "slide1.jpg"), quality=95)

# ==============================================================================
# SLIDE 2: The Empirical Baseline
# ==============================================================================
def render_slide2():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 130))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    draw.text((120, 90), "EMPIRICAL METHODOLOGY // UNMODIFIED SYSTEM", fill=(56, 189, 248, 255), font=font_tag)
    draw.text((120, 130), "5 REPRESENTATIVE LOCAL WORKLOADS", fill=(255, 255, 255, 255), font=font_title)
    draw.text((120, 210), "Measuring authentic harness operations before debating conversion or rewrites.", fill=(148, 163, 184, 255), font=font_subtitle)

    workloads = [
        ("1. Stream XML Parsing & Dispatch", "parseAssistantMessageV2 chunked token ingestion & ActionExecutor turn reservation."),
        ("2. Project Search & Context Prep", "Recursive workspace traversal, regex controller search, and TokenService budgeting."),
        ("3. SQLite WAL State & CAS Persistence", "Atomic session graph commits, content-addressed block seeks, and state hydration."),
        ("4. Tool Diff Patching & Mutation", "constructNewFileContent multi-hunk search/replace fuzzy diffing and SHA-256 verification."),
        ("5. End-to-End Agent Task Cycle", "Deterministic 4-step task loop: Discover -> Inspect -> Patch -> Verify & Complete.")
    ]

    for i, (title, desc) in enumerate(workloads):
        cy = 280 + i * 125
        draw_glass_card(draw, 120, cy, 1680, 105, fill=(15, 23, 42, 210), outline=(56, 189, 248, 100))
        # Badge
        draw.rounded_rectangle([145, cy + 24, 195, cy + 80], radius=8, fill=(30, 41, 59, 255), outline=(56, 189, 248, 200))
        draw.text((160, cy + 36), f"0{i+1}", fill=(56, 189, 248, 255), font=font_card_title)
        
        draw.text((220, cy + 22), title, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((220, cy + 60), desc, fill=(148, 163, 184, 255), font=font_card_body)

    draw.text((120, 960), "Tested on Revision: e0a200fc | Zero Production Code Changes | Apple M1 Pro 10-Core", fill=(100, 116, 139, 255), font=font_tag)
    img.convert("RGB").save(os.path.join(out_dir, "slide2.jpg"), quality=95)

# ==============================================================================
# SLIDE 3: The Millisecond Reality
# ==============================================================================
def render_slide3():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 140))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    draw.text((120, 90), "MEASURED EVIDENCE // APPLE SILICON DARWIN ARM64", fill=(16, 185, 129, 255), font=font_tag)
    draw.text((120, 130), "EVERY LOCAL OPERATION RUNS IN MILLISECONDS", fill=(255, 255, 255, 255), font=font_title)
    draw.text((120, 210), "Deterministic local harness execution is decoupled from remote model queue latency.", fill=(148, 163, 184, 255), font=font_subtitle)

    metrics = [
        ("17 µs", "0.017 ms", "AST Diff Patching", "2,124,352 lines/sec"),
        ("122 µs", "0.122 ms", "SQLite WAL & CAS", "230,769 ops/sec"),
        ("634 µs", "0.634 ms", "Project Search & Context", "37,325 files/sec"),
        ("728 µs", "0.728 ms", "Full 4-Step E2E Cycle", "5,329 steps/sec"),
        ("2.90 ms", "2.903 ms", "5-Turn XML Dispatch", "1,279 turns/sec")
    ]

    card_w = 315
    card_h = 360
    card_y = 300
    for i, (val, subval, name, rate) in enumerate(metrics):
        cx = 120 + i * (card_w + 26)
        draw_glass_card(draw, cx, card_y, card_w, card_h, fill=(15, 23, 42, 230), outline=(16, 185, 129, 160))
        
        draw.text((cx + 25, card_y + 35), "MEDIAN p50", fill=(56, 189, 248, 255), font=font_tag)
        draw.text((cx + 25, card_y + 75), val, fill=(16, 185, 129, 255), font=font_metric_val)
        draw.text((cx + 25, card_y + 135), f"({subval})", fill=(148, 163, 184, 255), font=font_card_body)
        
        # Divider line
        draw.line([cx + 25, card_y + 190, cx + card_w - 25, card_y + 190], fill=(51, 65, 85, 255), width=1)
        
        draw.text((cx + 25, card_y + 220), name, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((cx + 25, card_y + 280), rate, fill=(56, 189, 248, 255), font=font_card_body)

    # Big Insight Card
    draw_glass_card(draw, 120, 720, 1680, 150, fill=(30, 41, 59, 240), outline=(245, 158, 11, 200))
    draw.text((160, 745), "KEY ARCHITECTURAL INSIGHT:", fill=(245, 158, 11, 255), font=font_card_title)
    draw.text((160, 790), "Local harness execution accounts for < 0.1% of turn latency in production.", fill=(255, 255, 255, 255), font=font_subtitle)
    draw.text((160, 825), "Remote LLM inference and streaming require 1,000 to 5,000 ms. Shaving 1 ms locally produces zero user-visible gain.", fill=(148, 163, 184, 255), font=font_card_body)

    draw.text((120, 960), "Data preserved in results/baseline-results.json | 100% Correctness Verified Across All Trials", fill=(100, 116, 139, 255), font=font_tag)
    img.convert("RGB").save(os.path.join(out_dir, "slide3.jpg"), quality=95)

# ==============================================================================
# SLIDE 4: Measure Before Rewriting
# ==============================================================================
def render_slide4():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 130))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    draw.text((120, 90), "ENGINEERING DISCIPLINE // DECISION ARCHITECTURE", fill=(56, 189, 248, 255), font=font_tag)
    draw.text((120, 130), "EVIDENCE BEFORE EFFORT", fill=(255, 255, 255, 255), font=font_title)
    draw.text((120, 210), "Why a reproducible baseline is the only honest foundation for architectural change.", fill=(148, 163, 184, 255), font=font_subtitle)

    # 2 Comparison Columns
    col_w = 810
    col_h = 560
    col_y = 290

    # Left: Guesswork
    draw_glass_card(draw, 120, col_y, col_w, col_h, fill=(24, 24, 27, 230), outline=(239, 68, 68, 140))
    draw.text((160, col_y + 40), "WITHOUT A BASELINE (GUESSWORK)", fill=(239, 68, 68, 255), font=font_card_title)
    draw.line([160, col_y + 85, 120 + col_w - 40, col_y + 85], fill=(69, 10, 10, 255), width=2)
    
    gw_items = [
        "Premature Optimization: Rewriting fast code while ignoring true bottlenecks.",
        "Unmeasured Claims: Declaring a new language '10x faster' without equal workloads.",
        "Hidden Regressions: Introducing subtle edge-case bugs and tooling fragility.",
        "Wasted Engineering Capital: Months spent rewriting what already executes in 1 ms."
    ]
    for gi, item in enumerate(gw_items):
        draw.text((160, col_y + 120 + gi * 95), f"✕  {item.split(':')[0]}:", fill=(252, 165, 165, 255), font=font_card_title)
        draw.text((195, col_y + 160 + gi * 95), item.split(':')[1].strip(), fill=(148, 163, 184, 255), font=font_card_body)

    # Right: Engineering
    draw_glass_card(draw, 990, col_y, col_w, col_h, fill=(15, 23, 42, 230), outline=(16, 185, 129, 160))
    draw.text((1030, col_y + 40), "WITH A BASELINE (LUMI PROTOCOL)", fill=(16, 185, 129, 255), font=font_card_title)
    draw.line([1030, col_y + 85, 990 + col_w - 40, col_y + 85], fill=(6, 78, 59, 255), width=2)
    
    eng_items = [
        "Target Real Constraints: Optimize where performance actually impacts humans.",
        "Equivalence Contract: contract.json enforces identical inputs and exact output hashes.",
        "Independent Workloads: Measure harness overhead separately from model latency.",
        "Decision by Evidence: Convert only if justified by distribution, binary size, or memory."
    ]
    for ei, item in enumerate(eng_items):
        draw.text((1030, col_y + 120 + ei * 95), f"✓  {item.split(':')[0]}:", fill=(110, 231, 183, 255), font=font_card_title)
        draw.text((1065, col_y + 160 + ei * 95), item.split(':')[1].strip(), fill=(148, 163, 184, 255), font=font_card_body)

    draw.text((120, 960), "A benchmark is not a victory lap. It is an instrument of intellectual honesty.", fill=(100, 116, 139, 255), font=font_tag)
    img.convert("RGB").save(os.path.join(out_dir, "slide4.jpg"), quality=95)

# ==============================================================================
# SLIDE 5: Engineering with Purpose
# ==============================================================================
def render_slide5():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 140))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    draw.text((120, 110), "HEAV3NS // CARD SORTING // LUMI", fill=(56, 189, 248, 255), font=font_tag)
    draw.text((120, 150), "BUILDING TOOLS THAT SERVE PEOPLE BETTER", fill=(255, 255, 255, 255), font=font_title)

    # Big Center Glass Card
    draw_glass_card(draw, 120, 270, 1680, 460, fill=(15, 23, 42, 230), outline=(56, 189, 248, 160))
    
    # Large Quote
    quote_l1 = "“Good infrastructure doesn't need to be visible to be valuable."
    quote_l2 = "But its benefits should always be measurable.”"
    draw.text((200, 360), quote_l1, fill=(255, 255, 255, 255), font=font_quote)
    draw.text((200, 430), quote_l2, fill=(16, 185, 129, 255), font=font_quote)

    subtext = "The goal of performance engineering is not to make a benchmark graph look impressive.\nIt is to understand our systems deeply, respect developer attention, and build software that endures."
    for sli, sl in enumerate(subtext.split("\n")):
        draw.text((200, 540 + sli * 36), sl, fill=(148, 163, 184, 255), font=font_subtitle)

    # 3 Badges at bottom
    badges = [
        ("Reproducible Baseline", "Fully Verified"),
        ("Conversion Contract", "contract.json Certified"),
        ("Deputy Gemini", "Lead Investigator")
    ]
    for bi, (b1, b2) in enumerate(badges):
        bx = 120 + bi * (530 + 45)
        by = 780
        draw_glass_card(draw, bx, by, 530, 120, fill=(30, 41, 59, 220), outline=(16, 185, 129, 120))
        draw.text((bx + 35, by + 28), b1, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((bx + 35, by + 68), b2, fill=(56, 189, 248, 255), font=font_card_body)

    draw.text((120, 960), "LUMI Pre-Conversion Benchmark Slice | Commissioning Authority: MAJO, Executive Chair", fill=(100, 116, 139, 255), font=font_tag)
    img.convert("RGB").save(os.path.join(out_dir, "slide5.jpg"), quality=95)

# ==============================================================================
# THUMBNAIL: High-Impact LinkedIn Thumbnail
# ==============================================================================
def render_thumbnail():
    img = base_bg.copy()
    overlay = Image.new("RGBA", (1920, 1080), (0, 0, 0, 110))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    font_thumb_super = get_font(32, bold=True)
    font_thumb_title = get_font(74, bold=True)
    font_thumb_sub = get_font(34, bold=False)

    draw.rounded_rectangle([120, 110, 400, 165], radius=10, fill=(16, 185, 129, 240))
    draw.text((140, 122), "LUMI BENCHMARK", fill=(15, 23, 42, 255), font=font_thumb_super)

    draw.text((120, 200), "THE ENGINEERING", fill=(255, 255, 255, 255), font=font_thumb_title)
    draw.text((120, 285), "PEOPLE NEVER SEE", fill=(56, 189, 248, 255), font=font_thumb_title)
    
    draw.text((120, 400), "Why performance engineering is about human flow, not just numbers.", fill=(203, 213, 225, 255), font=font_thumb_sub)

    # Metrics highlight ribbon
    draw_glass_card(draw, 120, 520, 1680, 280, fill=(15, 23, 42, 240), outline=(56, 189, 248, 160))
    
    t_metrics = [
        ("17 µs", "Diff Patching"),
        ("122 µs", "SQLite CAS"),
        ("634 µs", "Context Prep"),
        ("0.73 ms", "End-to-End Task")
    ]
    for mi, (mv, ml) in enumerate(t_metrics):
        mx = 160 + mi * 410
        draw.text((mx, 560), mv, fill=(16, 185, 129, 255), font=get_font(60, bold=True))
        draw.text((mx, 650), ml, fill=(255, 255, 255, 255), font=font_card_title)
        draw.text((mx, 700), "Median Latency", fill=(148, 163, 184, 255), font=font_card_body)
        if mi < 3:
            draw.line([mx + 360, 560, mx + 360, 740], fill=(51, 65, 85, 255), width=2)

    # Bottom Banner
    draw.text((120, 890), "Deputy Gemini // Lead Investigator & Presenter", fill=(56, 189, 248, 255), font=font_thumb_sub)
    draw.text((120, 950), "Empirical Research Baseline Prior to Language Conversion", fill=(148, 163, 184, 255), font=font_card_body)

    thumb_path = "evals/benchmarks/lumi-pre-conversion-slice/pr_package/thumbnail.png"
    img.convert("RGB").save(thumb_path, quality=95)
    print(f"Thumbnail saved to {thumb_path}")

print("Rendering all 5 video slides and thumbnail...")
render_slide1()
render_slide2()
render_slide3()
render_slide4()
render_slide5()
render_thumbnail()
print("All slides and thumbnail rendered successfully!")
