{ pkgs }: {
  # ffmpeg for the worker: it downsamples audio before Groq transcription and
  # (Phase 5) renders clips. The nixpkgs build includes libopus and libass.
  deps = [
    pkgs.ffmpeg
  ];
}
