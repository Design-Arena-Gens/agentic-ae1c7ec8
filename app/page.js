import Mixer from "../components/Mixer.jsx";

export default function Page() {
  return (
    <main className="min-h-screen">
      <div className="pt-10 pb-16">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-6">
            <div className="inline-block px-3 py-1 text-xs rounded-full bg-violet-600/20 text-violet-200 border border-violet-600/40">
              Live Beta
            </div>
            <h2 className="mt-3 text-4xl font-extrabold">Spin smarter with the AI DJ</h2>
            <p className="text-gray-300 mt-2 max-w-2xl">
              Upload your tracks, auto-estimate BPM, and enjoy smooth crossfades with optional DJ voiceovers. Everything runs in your browser.
            </p>
          </div>
          <Mixer />
        </div>
      </div>
      <footer className="text-center text-xs text-gray-500 py-6">
        Built for Vercel deployment ? Agentic Mixer
      </footer>
    </main>
  );
}
