import os
import subprocess

pkg_dir = os.path.dirname(os.path.abspath(__file__))
audio_dir = os.path.join(pkg_dir, "audio")
os.makedirs(audio_dir, exist_ok=True)

parts = [
    {
        "id": "scene1",
        "title": "Introducing Agent Swarm & The Legion (LUMI v26.5.0)",
        "text": (
            "Meet LUMI twenty-six point five: Agent Swarm and The Legion. "
            "Single-stream coding agents hit a wall on complex systems. "
            "LUMI transforms one prompt into an autonomous, multi-agent engineering organization, "
            "combining Hierarchical Defer and Resume, Critical Completion Review, and The Legion specialist engine."
        ),
    },
    {
        "id": "scene2",
        "title": "Orchestrator Conductor & 10 Specialist Archetypes",
        "text": (
            "At the center is the Orchestrator Conductor. "
            "Using the auto-approved engage swarm tool, the conductor classifies your objective across ten specialist archetypes "
            "and dispatches dependency-ordered DAG stages: Lead and Recon, Parallel Execution, and Verification and Hardening. "
            "Real-time progress cards stream into chat while strict file-reservation partitioning prevents edit collisions."
        ),
    },
    {
        "id": "scene3",
        "title": "Self-Healing Streams & Multi-Tier Terminal Defense",
        "text": (
            "Under the hood, Phases eight through ten deliver rock-solid execution resilience. "
            "A state-machine JSON root parser deduplicates streaming tool snapshots and self-heals concatenated payloads. "
            "Multi-tier terminal guards intercept heredoc file writes and raw file dumps before execution, "
            "preventing shell deadlocks while decoupling specialist token budgets from turn starvation."
        ),
    },
    {
        "id": "scene4",
        "title": "Phase 11: Dynamic Knowledge Blackboard, Integrity & Handoffs",
        "text": (
            "New in Phase eleven: workspace-scoped dynamic project knowledge shares verified insights across stages via a Swarm Blackboard, "
            "automatically scrubbed against credential leaks. "
            "Manifest fingerprinting reactively invalidates environment caches on file edits. "
            "Supervised shells enforce view-epoch fencing, while surrogate-safe XML handoffs and two-phase reservations guarantee zero duplicate failovers."
        ),
    },
    {
        "id": "scene5",
        "title": "Empirically Verified at Scale",
        "text": (
            "Every invariant is backed by real SQLite persistence, twenty Architecture Decision Records, and nineteen blameless post-mortems. "
            "Verified across nine hundred and fifty-two automated tests with zero TypeScript or lint errors. "
            "LUMI Agent Swarm and The Legion: autonomous scale, cryptographic safety, and calm developer flow."
        ),
    },
]

durations = []
for p in parts:
    aiff_path = os.path.join(audio_dir, f"{p['id']}.aiff")
    wav_path = os.path.join(audio_dir, f"{p['id']}.wav")

    # Generate clear narration using macOS Samantha voice at crisp 172 wpm hype cadence
    subprocess.run(
        ["say", "-v", "Samantha", "-r", "172", "-o", aiff_path, p["text"]],
        check=True,
    )

    # Convert to 48kHz stereo WAV with a 0.45s trailing pad for clean transitions
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            aiff_path,
            "-af",
            "apad=pad_dur=0.45",
            "-ar",
            "48000",
            "-ac",
            "2",
            wav_path,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Remove intermediate AIFF
    if os.path.exists(aiff_path):
        os.remove(aiff_path)

    res = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            wav_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    dur = float(res.stdout.strip())
    durations.append((p["id"], dur, p["title"], p["text"]))
    print(f"[{p['id']}] Duration: {dur:.3f}s | {p['title']}")

total = sum(d[1] for d in durations)
print(f"\nTotal Demo Narration Duration: {total:.3f}s ({total/60:.2f} mins)")

