import os
from PIL import Image, ImageDraw, ImageFont

def render_comparison_card(output_path):
    # Dimensions (2x Retina scale)
    W, H = 1400, 1120
    im = Image.new("RGBA", (W, H), (8, 8, 8, 255))
    draw = ImageDraw.Draw(im)

    # Fonts
    font_serif_bold = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", 46)
    font_serif_reg = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 46)
    font_sans_bold = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 34)
    font_sans_med = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 24)
    font_sans_reg = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 21)
    font_stat_num = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 44)
    font_stat_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
    font_header_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 25)
    font_header_meta = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)

    # Colors
    c_card_bg = (249, 249, 248, 255)
    c_orange = (204, 97, 53, 255)      # Claude Terracotta
    c_emerald = (13, 148, 136, 255)    # Broccoli Teal/Emerald (#0D9488)
    c_text_dark = (22, 22, 22, 255)
    c_text_muted = (115, 115, 115, 255)
    c_divider = (230, 230, 226, 255)

    # Card Rect
    card_x0, card_y0 = 60, 50
    card_x1, card_y1 = W - 60, H - 50
    card_radius = 32

    # Draw rounded card with subtle border
    draw.rounded_rectangle([card_x0, card_y0, card_x1, card_y1], radius=card_radius, fill=c_card_bg)

    # Title line
    # "12x faster in HEAV3NS-CODE, 3x in Claude Code"
    # We measure text chunks to center them nicely
    parts = [
        ("12x ", c_emerald, font_serif_bold),
        ("faster in HEAV3NS-CODE, ", c_text_dark, font_serif_reg),
        ("3x ", c_orange, font_serif_bold),
        ("in Claude Code", c_text_dark, font_serif_reg),
    ]

    total_title_w = sum(draw.textbbox((0, 0), text, font=font)[2] for text, _, font in parts)
    curr_x = (W - total_title_w) / 2
    title_y = card_y0 + 55

    for text, color, font in parts:
        draw.text((curr_x, title_y), text, fill=color, font=font)
        curr_x += draw.textbbox((0, 0), text, font=font)[2]

    # Subtitles
    sub1 = "Wait before the first token, excluding model time"
    sub1_w = draw.textbbox((0, 0), sub1, font=font_header_sub)[2]
    draw.text(((W - sub1_w) / 2, title_y + 65), sub1, fill=c_text_dark, font=font_header_sub)

    sub2 = "p90 · Empirical Measurements (Commission 012) vs. Reference Figures"
    sub2_w = draw.textbbox((0, 0), sub2, font=font_header_meta)[2]
    draw.text(((W - sub2_w) / 2, title_y + 102), sub2, fill=c_text_muted, font=font_header_meta)

    # Initial divider
    div_y = title_y + 140
    draw.line([card_x0 + 45, div_y, card_x1 - 45, div_y], fill=c_divider, width=2)

    # Rows Definition
    rows = [
        {
            "title": "HEAV3NS-CODE (local sessions)",
            "subtitle": "Spider AST skeletonization + SQLite CAS Gzip · 5 Mbps uplink",
            "stat": "12x faster",
            "stat_color": c_emerald,
            "substat": "4.12 s → 0.34 s",
        },
        {
            "title": "Claude Code (local sessions)",
            "subtitle": "Anthropic October 2026 published reference · 4.07 s baseline",
            "stat": "3x faster",
            "stat_color": c_orange,
            "substat": "4.07 s → 1.33 s",
        },
        {
            "title": "HEAV3NS-CODE (cloud & remote sessions)",
            "subtitle": "Constrained remote egress with durable pre-compression",
            "stat": "9.2x faster",
            "stat_color": c_emerald,
            "substat": "16.99 s → 1.85 s",
        },
        {
            "title": "Claude Code (cloud sessions)",
            "subtitle": "Anthropic October 2026 published reference · 16.99 s baseline",
            "stat": "2.8x faster",
            "stat_color": c_orange,
            "substat": "16.99 s → 6.00 s",
        },
        {
            "title": "Multi-turn stream assembly (local CPU)",
            "subtitle": "HEAV3NS-CODE SQLite CAS hit vs. full payload re-compression (500 KB)",
            "stat": "3.8x faster",
            "stat_color": c_emerald,
            "substat": "2.99 ms → 0.78 ms",
        },
    ]

    row_start_y = div_y + 20
    row_height = 145

    for i, r in enumerate(rows):
        y = row_start_y + i * row_height
        left_x = card_x0 + 55
        right_x = card_x1 - 55

        # Left Column: Title + Subtitle
        draw.text((left_x, y + 15), r["title"], fill=c_text_dark, font=font_sans_bold)
        draw.text((left_x, y + 55), r["subtitle"], fill=c_text_muted, font=font_sans_reg)

        # Right Column: Big Stat + Substat
        stat_w = draw.textbbox((0, 0), r["stat"], font=font_stat_num)[2]
        draw.text((right_x - stat_w, y + 10), r["stat"], fill=r["stat_color"], font=font_stat_num)

        substat_w = draw.textbbox((0, 0), r["substat"], font=font_stat_sub)[2]
        draw.text((right_x - substat_w, y + 60), r["substat"], fill=c_text_muted, font=font_stat_sub)

        # Divider (except after last row)
        if i < len(rows) - 1:
            curr_div_y = y + row_height - 15
            draw.line([card_x0 + 45, curr_div_y, card_x1 - 45, curr_div_y], fill=c_divider, width=2)

    # Save image
    im.save(output_path, "PNG")
    print(f"✅ Generated comparison card: {output_path}")

def render_side_by_side(output_path):
    W, H = 2200, 1100
    im = Image.new("RGBA", (W, H), (8, 8, 8, 255))
    draw = ImageDraw.Draw(im)

    font_top = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 36)
    font_serif_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia Bold.ttf", 38)
    font_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 22)
    font_meta = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    font_row_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 26)
    font_row_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    font_stat = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 36)
    font_stat_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 19)

    c_card_bg = (249, 249, 248, 255)
    c_orange = (204, 97, 53, 255)
    c_emerald = (13, 148, 136, 255)
    c_text_dark = (22, 22, 22, 255)
    c_text_muted = (115, 115, 115, 255)
    c_divider = (230, 230, 226, 255)

    # Top Header
    header_text = "COMMISSION 012 · HEAD-TO-HEAD BENCHMARK COMPARISON"
    hw = draw.textbbox((0, 0), header_text, font=font_top)[2]
    draw.text(((W - hw)/2, 35), header_text, fill=(255, 255, 255, 255), font=font_top)

    card_w = 980
    card_h = 920
    y0 = 110

    # LEFT CARD: Claude Code (Anthropic Reference)
    x_left = 80
    draw.rounded_rectangle([x_left, y0, x_left + card_w, y0 + card_h], radius=28, fill=c_card_bg)

    t1 = "3x faster in Claude Code, 1.5x in Claude"
    draw.text((x_left + 40, y0 + 40), t1, fill=c_orange, font=font_serif_title)
    draw.text((x_left + 40, y0 + 95), "Wait before the first token, excluding model time", fill=c_text_dark, font=font_sub)
    draw.text((x_left + 40, y0 + 130), "p90 · August → October 2026 (Published Reference)", fill=c_text_muted, font=font_meta)
    draw.line([x_left + 40, y0 + 165, x_left + card_w - 40, y0 + 165], fill=c_divider, width=2)

    left_rows = [
        ("Claude Code (local sessions)", "HTTP Gzip request body compression", "3x faster", "4.07 s → 1.33 s"),
        ("Claude Code (cloud sessions)", "Pre-warmed remote initialization", "2.8x faster", "16.99 s → 6.00 s"),
        ("Claude (chat and Cowork)", "Web socket compression & caching", "1.5x faster", "3.36 s → 2.17 s"),
        ("Claude API (TTFT p50)", "Time to first token including model time", "1.5x faster", "1.53 s → 1.01 s"),
        ("Multi-turn stream assembly", "Full payload re-compression on every turn", "1.0x", "2.99 ms (baseline)"),
    ]

    for i, (rt, rsub, stat, ssub) in enumerate(left_rows):
        ry = y0 + 195 + i * 135
        draw.text((x_left + 40, ry), rt, fill=c_text_dark, font=font_row_title)
        draw.text((x_left + 40, ry + 35), rsub, fill=c_text_muted, font=font_row_sub)
        
        sw = draw.textbbox((0, 0), stat, font=font_stat)[2]
        draw.text((x_left + card_w - 40 - sw, ry - 5), stat, fill=c_orange, font=font_stat)
        ssw = draw.textbbox((0, 0), ssub, font=font_stat_sub)[2]
        draw.text((x_left + card_w - 40 - ssw, ry + 38), ssub, fill=c_text_muted, font=font_stat_sub)
        if i < len(left_rows) - 1:
            draw.line([x_left + 40, ry + 85, x_left + card_w - 40, ry + 85], fill=c_divider, width=2)

    # RIGHT CARD: HEAV3NS-CODE (Commission 012 Methodology)
    x_right = W - 80 - card_w
    draw.rounded_rectangle([x_right, y0, x_right + card_w, y0 + card_h], radius=28, fill=c_card_bg)

    t2 = "12x faster with HEAV3NS-CODE"
    draw.text((x_right + 40, y0 + 40), t2, fill=c_emerald, font=font_serif_title)
    draw.text((x_right + 40, y0 + 95), "Wait before the first token, excluding model time", fill=c_text_dark, font=font_sub)
    draw.text((x_right + 40, y0 + 130), "p90 · Commission 012 Controlled Benchmark vs. Oct 2026 Reference", fill=c_text_muted, font=font_meta)
    draw.line([x_right + 40, y0 + 165, x_right + card_w - 40, y0 + 165], fill=c_divider, width=2)

    right_rows = [
        ("HEAV3NS-CODE (local sessions, 5 Mbps)", "Spider AST skeletonization + CAS Gzip", "12x faster", "4.12 s → 0.34 s"),
        ("HEAV3NS-CODE (local sessions, 15 Mbps)", "Broadband uplink with RFC 1952 multi-member", "11.9x faster", "1.37 s → 0.11 s"),
        ("HEAV3NS-CODE (cloud sessions)", "Constrained egress with durable CAS pre-compression", "9.2x faster", "16.99 s → 1.85 s"),
        ("Context mass (Turn 25 payload)", "Spider AST skeletonization (-71.2% mass)", "17.9x smaller", "2,500 KB → 140 KB"),
        ("Multi-turn stream assembly", "SQLite WAL CAS chunk hit (6.5µs seek)", "3.8x faster", "2.99 ms → 0.78 ms"),
    ]

    for i, (rt, rsub, stat, ssub) in enumerate(right_rows):
        ry = y0 + 195 + i * 135
        draw.text((x_right + 40, ry), rt, fill=c_text_dark, font=font_row_title)
        draw.text((x_right + 40, ry + 35), rsub, fill=c_text_muted, font=font_row_sub)
        
        sw = draw.textbbox((0, 0), stat, font=font_stat)[2]
        draw.text((x_right + card_w - 40 - sw, ry - 5), stat, fill=c_emerald, font=font_stat)
        ssw = draw.textbbox((0, 0), ssub, font=font_stat_sub)[2]
        draw.text((x_right + card_w - 40 - ssw, ry + 38), ssub, fill=c_text_muted, font=font_stat_sub)
        if i < len(right_rows) - 1:
            draw.line([x_right + 40, ry + 85, x_right + card_w - 40, ry + 85], fill=c_divider, width=2)

    im.save(output_path, "PNG")
    print(f"✅ Generated side-by-side showdown: {output_path}")

if __name__ == "__main__":
    out_dir = "/Users/bozoegg/Downloads/LUMI"
    p1 = os.path.join(out_dir, "benchmark_comparison_card.png")
    p2 = os.path.join(out_dir, "benchmark_side_by_side_showdown.png")
    render_comparison_card(p1)
    render_side_by_side(p2)
