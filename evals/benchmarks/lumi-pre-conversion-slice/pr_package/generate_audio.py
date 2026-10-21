import subprocess
import os

parts = [
    {
        "id": "scene1",
        "title": "The Invisible Machinery",
        "text": "Most people never think about the machinery inside the software they use. And they shouldn't have to. Developers should be able to focus on their creative flow, not wait for their tools. But that experience is shaped by engineering decisions that are often completely invisible."
    },
    {
        "id": "scene2",
        "title": "The Empirical Baseline",
        "text": "Before considering any rewrite or language migration for LUMI, we measured what actually exists. We established an empirical baseline across five core local workloads: stream parsing, workspace discovery, SQLite state persistence, diff patching, and full end-to-end task cycles."
    },
    {
        "id": "scene3",
        "title": "The Millisecond Reality",
        "text": "The data reveals that every single local operation already executes in milliseconds or less: from seventeen microseconds for fuzzy diffs, to under three milliseconds for turn dispatch."
    },
    {
        "id": "scene4",
        "title": "Measure Before Rewriting",
        "text": "Why does that matter? Because without a baseline, you cannot know if a proposed rewrite makes things better or simply adds complexity. Measuring first ensures engineering effort targets constraints that actually impact people, rather than optimizing what is already fast."
    },
    {
        "id": "scene5",
        "title": "Engineering with Purpose",
        "text": "The goal of performance engineering isn't to make a synthetic benchmark look impressive. It's to build software that serves people better. Good infrastructure doesn't need to be visible to be valuable. But its benefits should always be measurable."
    }
]

out_dir = "evals/benchmarks/lumi-pre-conversion-slice/pr_package/audio"
os.makedirs(out_dir, exist_ok=True)

durations = []
for p in parts:
    aiff_path = os.path.join(out_dir, f"{p['id']}.aiff")
    wav_path = os.path.join(out_dir, f"{p['id']}.wav")
    
    # Generate speech
    subprocess.run(["say", "-v", "Samantha", "-r", "165", "-o", aiff_path, p["text"]], check=True)
    
    # Convert to standard 48kHz WAV with a 0.4s trailing silence pad for smooth breathing room
    subprocess.run([
        "ffmpeg", "-y", "-i", aiff_path,
        "-af", "apad=pad_dur=0.4",
        "-ar", "48000", "-ac", "2",
        wav_path
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Get exact duration
    res = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", wav_path
    ], capture_output=True, text=True, check=True)
    
    dur = float(res.stdout.strip())
    durations.append((p["id"], dur, p["title"], p["text"]))
    print(f"[{p['id']}] Duration: {dur:.3f}s | {p['title']}")

total = sum(d[1] for d in durations)
print(f"\nTotal Video Narration Duration: {total:.3f}s ({total/60:.2f} mins)")
