import os
import subprocess

pkg_dir = os.path.dirname(os.path.abspath(__file__))
audio_dir = os.path.join(pkg_dir, "audio")
slides_dir = os.path.join(pkg_dir, "slides")
video_dir = os.path.join(pkg_dir, "video")
os.makedirs(video_dir, exist_ok=True)

scenes = [
    {
        "id": "scene1",
        "slide": os.path.join(slides_dir, "slide1.jpg"),
        "audio": os.path.join(audio_dir, "scene1.wav"),
        "subtitles": [
            (0.0, 4.2, "Meet LUMI 26.5: Agent Swarm and The Legion."),
            (4.4, 8.2, "Single-stream coding agents hit a wall on complex systems."),
            (8.4, 13.5, "LUMI transforms one prompt into an autonomous, multi-agent engineering organization,"),
            (13.7, 18.8, "combining Hierarchical Defer & Resume, Critical Completion Review, and The Legion specialist engine."),
        ],
    },
    {
        "id": "scene2",
        "slide": os.path.join(slides_dir, "slide2.jpg"),
        "audio": os.path.join(audio_dir, "scene2.wav"),
        "subtitles": [
            (0.0, 3.2, "At the center is the Orchestrator Conductor."),
            (3.4, 9.8, "Using the auto-approved engage_swarm tool, the conductor classifies your objective across 10 specialist archetypes"),
            (10.0, 16.5, "and dispatches dependency-ordered DAG stages: Lead & Recon, Parallel Execution, and Verification & Hardening."),
            (16.7, 22.6, "Real-time progress cards stream into chat while strict file-reservation partitioning prevents edit collisions."),
        ],
    },
    {
        "id": "scene3",
        "slide": os.path.join(slides_dir, "slide3.jpg"),
        "audio": os.path.join(audio_dir, "scene3.wav"),
        "subtitles": [
            (0.0, 4.8, "Under the hood, Phases 8 through 10 deliver rock-solid execution resilience."),
            (5.0, 11.2, "A state-machine JSON root parser deduplicates streaming tool snapshots and self-heals concatenated payloads."),
            (11.4, 16.8, "Multi-tier terminal guards intercept heredoc file writes and raw file dumps before execution,"),
            (17.0, 21.9, "preventing shell deadlocks while decoupling specialist token budgets from turn starvation."),
        ],
    },
    {
        "id": "scene4",
        "slide": os.path.join(slides_dir, "slide4.jpg"),
        "audio": os.path.join(audio_dir, "scene4.wav"),
        "subtitles": [
            (0.0, 7.2, "New in Phase 11: workspace-scoped dynamic project knowledge shares verified insights across stages via a Swarm Blackboard,"),
            (7.4, 11.2, "automatically scrubbed against credential leaks."),
            (11.4, 16.2, "Manifest fingerprinting reactively invalidates environment caches on file edits."),
            (16.4, 24.4, "Supervised shells enforce view-epoch fencing, while surrogate-safe XML handoffs and two-phase reservations guarantee zero duplicate failovers."),
        ],
    },
    {
        "id": "scene5",
        "slide": os.path.join(slides_dir, "slide5.jpg"),
        "audio": os.path.join(audio_dir, "scene5.wav"),
        "subtitles": [
            (0.0, 7.6, "Every invariant is backed by real SQLite persistence, 20 Architecture Decision Records, and 19 blameless post-mortems."),
            (7.8, 13.8, "Verified across 952 automated tests with zero TypeScript or lint errors."),
            (14.0, 20.1, "LUMI Agent Swarm and The Legion: autonomous scale, cryptographic safety, and calm developer flow."),
        ],
    },
]

# 1. Build individual scene MP4s
scene_mp4s = []
for s in scenes:
    out_mp4 = os.path.join(video_dir, f"{s['id']}.mp4")
    print(f"Rendering {s['id']}.mp4...")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loop",
            "1",
            "-i",
            s["slide"],
            "-i",
            s["audio"],
            "-c:v",
            "libx264",
            "-tune",
            "stillimage",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            out_mp4,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    scene_mp4s.append(out_mp4)

# 2. Write concat list
concat_list_path = os.path.join(video_dir, "concat_list.txt")
with open(concat_list_path, "w") as f:
    for mp4 in scene_mp4s:
        f.write(f"file '{os.path.abspath(mp4)}'\n")

# 3. Concatenate into master video
master_video = os.path.join(video_dir, "agentswarm_launch_demo.mp4")
print("Concatenating master video...")
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat_list_path,
        "-c",
        "copy",
        master_video,
    ],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
print(f"Master video rendered: {master_video}")


# 4. Generate Master SRT and VTT Captions
def format_time_srt(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_time_vtt(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


srt_path = os.path.join(pkg_dir, "captions.srt")
vtt_path = os.path.join(pkg_dir, "captions.vtt")

current_time_offset = 0.0
srt_entries = []
vtt_entries = ["WEBVTT\n"]
caption_idx = 1

for s in scenes:
    res = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            s["audio"],
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    scene_dur = float(res.stdout.strip())

    for start, end, text in s["subtitles"]:
        abs_start = current_time_offset + start
        abs_end = min(current_time_offset + end, current_time_offset + scene_dur)

        srt_entries.append(
            f"{caption_idx}\n{format_time_srt(abs_start)} --> {format_time_srt(abs_end)}\n{text}\n"
        )
        vtt_entries.append(
            f"{caption_idx}\n{format_time_vtt(abs_start)} --> {format_time_vtt(abs_end)}\n{text}\n"
        )
        caption_idx += 1

    current_time_offset += scene_dur

with open(srt_path, "w") as f:
    f.write("\n".join(srt_entries))
with open(vtt_path, "w") as f:
    f.write("\n".join(vtt_entries))

print(f"Generated SRT: {srt_path}")
print(f"Generated VTT: {vtt_path}")

# 5. Render burned-in subtitle version
burned_sub_video = os.path.join(video_dir, "agentswarm_launch_demo_subtitled.mp4")
print("Rendering burned-in subtitle version...")
sub_style = "FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,MarginV=35"
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-i",
        master_video,
        "-vf",
        f"subtitles={srt_path}:force_style='{sub_style}'",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-c:a",
        "copy",
        burned_sub_video,
    ],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

print(f"Burned-in subtitled video rendered: {burned_sub_video}")
print("Video build completed successfully!")

