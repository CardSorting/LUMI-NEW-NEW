import subprocess
import os

pkg_dir = "evals/benchmarks/lumi-pre-conversion-slice/pr_package"
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
            (0.0, 4.8, "Most people never think about the machinery inside the software they use."),
            (5.0, 7.8, "And they shouldn't have to."),
            (8.0, 11.8, "Developers should be able to focus on their creative flow, not wait for their tools."),
            (12.0, 15.2, "But that experience is shaped by engineering decisions that are often completely invisible.")
        ]
    },
    {
        "id": "scene2",
        "slide": os.path.join(slides_dir, "slide2.jpg"),
        "audio": os.path.join(audio_dir, "scene2.wav"),
        "subtitles": [
            (0.0, 5.2, "Before considering any rewrite or language migration for LUMI,"),
            (5.4, 8.2, "we measured what actually exists."),
            (8.4, 13.0, "We established an empirical baseline across five core local workloads:"),
            (13.2, 18.0, "stream parsing, workspace discovery, SQLite state, diff patching, and full end-to-end cycles.")
        ]
    },
    {
        "id": "scene3",
        "slide": os.path.join(slides_dir, "slide3.jpg"),
        "audio": os.path.join(audio_dir, "scene3.wav"),
        "subtitles": [
            (0.0, 4.5, "The data reveals that every single local operation already executes in milliseconds or less:"),
            (4.7, 7.5, "from seventeen microseconds for fuzzy diffs,"),
            (7.7, 10.8, "to under three milliseconds for turn dispatch.")
        ]
    },
    {
        "id": "scene4",
        "slide": os.path.join(slides_dir, "slide4.jpg"),
        "audio": os.path.join(audio_dir, "scene4.wav"),
        "subtitles": [
            (0.0, 2.0, "Why does that matter?"),
            (2.2, 7.0, "Because without a baseline, you cannot know if a proposed rewrite makes things better or simply adds complexity."),
            (7.2, 11.2, "Measuring first ensures engineering effort targets constraints that actually impact people,"),
            (11.4, 15.4, "rather than optimizing what is already fast.")
        ]
    },
    {
        "id": "scene5",
        "slide": os.path.join(slides_dir, "slide5.jpg"),
        "audio": os.path.join(audio_dir, "scene5.wav"),
        "subtitles": [
            (0.0, 4.6, "The goal of performance engineering isn't to make a synthetic benchmark look impressive."),
            (4.8, 8.2, "It's to build software that serves people better."),
            (8.4, 11.2, "Good infrastructure doesn't need to be visible to be valuable."),
            (11.4, 13.0, "But its benefits should always be measurable.")
        ]
    }
]

# 1. Build individual scene MP4s
scene_mp4s = []
for s in scenes:
    out_mp4 = os.path.join(video_dir, f"{s['id']}.mp4")
    print(f"Rendering {s['id']}.mp4...")
    subprocess.run([
        "ffmpeg", "-y",
        "-loop", "1", "-i", s["slide"],
        "-i", s["audio"],
        "-c:v", "libx264", "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        out_mp4
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    scene_mp4s.append(out_mp4)

# 2. Concat list
concat_list_path = os.path.join(video_dir, "concat_list.txt")
with open(concat_list_path, "w") as f:
    for mp4 in scene_mp4s:
        f.write(f"file '{os.path.abspath(mp4)}'\n")

# 3. Concatenate into master video
master_video = os.path.join(video_dir, "lumi_invisible_engineering.mp4")
print("Concatenating master video...")
subprocess.run([
    "ffmpeg", "-y",
    "-f", "concat", "-safe", "0",
    "-i", concat_list_path,
    "-c", "copy",
    master_video
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

# Durations of scenes
for s in scenes:
    res = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", s["audio"]
    ], capture_output=True, text=True, check=True)
    scene_dur = float(res.stdout.strip())

    for (start, end, text) in s["subtitles"]:
        abs_start = current_time_offset + start
        abs_end = min(current_time_offset + end, current_time_offset + scene_dur)
        
        # SRT
        srt_entries.append(f"{caption_idx}\n{format_time_srt(abs_start)} --> {format_time_srt(abs_end)}\n{text}\n")
        # VTT
        vtt_entries.append(f"{caption_idx}\n{format_time_vtt(abs_start)} --> {format_time_vtt(abs_end)}\n{text}\n")
        caption_idx += 1
        
    current_time_offset += scene_dur

with open(srt_path, "w") as f:
    f.write("\n".join(srt_entries))
with open(vtt_path, "w") as f:
    f.write("\n".join(vtt_entries))

print(f"Generated SRT: {srt_path}")
print(f"Generated VTT: {vtt_path}")

# 5. Render burned-in subtitle version for seamless mobile viewing
burned_sub_video = os.path.join(video_dir, "lumi_invisible_engineering_subtitled.mp4")
print("Rendering burned-in subtitle version...")
# Subtitles filter with Arial Bold, yellow-white font with semi-transparent background box
sub_style = "FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,MarginV=35"
subprocess.run([
    "ffmpeg", "-y",
    "-i", master_video,
    "-vf", f"subtitles={srt_path}:force_style='{sub_style}'",
    "-c:v", "libx264", "-crf", "18",
    "-c:a", "copy",
    burned_sub_video
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print(f"Burned-in subtitled video rendered: {burned_sub_video}")
print("Video build completed successfully!")
