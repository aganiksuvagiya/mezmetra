import { useEffect, useRef, useState } from 'react';
import { CAMERA_PROBLEM_TEXT, cameraProblem, decodeCanvas, decodeImageFile, describeCameraError } from '../lib/qrScan';
import { parseTableLink } from '../lib/ids';
import { CloseIcon, ImageIcon, SpinnerIcon } from './Icons';

const NOT_TABLE = "That QR code isn't a MezMitra table code. Scan the code on your table.";
const NO_CODE_IN_PHOTO = "We couldn't find a QR code in that photo. Try again closer to the code and in good light.";

const Corner = ({ className }) => <span aria-hidden="true" className={`absolute size-9 border-white ${className}`} />;

/**
 * Full-screen camera scanner. Calls onToken(token) with the 32-hex table token as soon as a table QR is read.
 * Falls back to a photo of the QR code when the camera is unavailable or blocked.
 */
export default function QrScanner({ onToken, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const closeRef = useRef(null);
  const [state, setState] = useState('starting'); // starting | scanning | blocked
  const [blockedText, setBlockedText] = useState('');
  const [notice, setNotice] = useState('');
  const [decodingPhoto, setDecodingPhoto] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  useEffect(() => {
    let stopped = false;
    let stream;
    let frame;
    let busy = false;
    let lastTick = 0;
    let lastNoticeAt = 0;

    const stopCamera = () => stream?.getTracks().forEach((t) => t.stop());

    const tick = async (now) => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!busy && now - lastTick > 140 && video?.readyState >= 2 && video.videoWidth) {
        busy = true;
        lastTick = now;
        try {
          const scale = Math.min(1, 720 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = await decodeCanvas(canvas);
          if (text && !stopped) {
            const token = parseTableLink(text);
            if (token) {
              stopped = true;
              stopCamera();
              onToken(token);
              return;
            }
            if (now - lastNoticeAt > 2500) {
              lastNoticeAt = now;
              setNotice(NOT_TABLE);
            }
          }
        } catch {
          /* a failed frame is not an error worth showing; try the next one */
        } finally {
          busy = false;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    (async () => {
      const problem = cameraProblem();
      if (problem) {
        setBlockedText(CAMERA_PROBLEM_TEXT[problem]);
        setState('blocked');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        if (!stopped) {
          setBlockedText(describeCameraError(err));
          setState('blocked');
        }
        return;
      }
      if (stopped) {
        stopCamera();
        return;
      }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setState('scanning');
      frame = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stopCamera();
    };
  }, [onToken]);

  const onPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setDecodingPhoto(true);
    setNotice('');
    try {
      const text = await decodeImageFile(file);
      const token = text && parseTableLink(text);
      if (token) onToken(token);
      else setNotice(text ? NOT_TABLE : NO_CODE_IN_PHOTO);
    } catch {
      setNotice(NO_CODE_IN_PHOTO);
    } finally {
      setDecodingPhoto(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Scan table QR code" className="fixed inset-0 z-50 flex flex-col bg-black text-white animate-fade-in">
      <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <h2 className="text-lg font-extrabold">Scan table QR code</h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close scanner"
          className="focus-on-dark grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25"
        >
          <CloseIcon className="size-5" />
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-md flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted autoPlay className={`absolute inset-0 size-full object-cover ${state === 'scanning' ? '' : 'invisible'}`} />
        <canvas ref={canvasRef} className="hidden" />

        {state === 'scanning' && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="relative aspect-square w-[68%] max-w-72 rounded-3xl shadow-[0_0_0_100vmax_rgb(0_0_0/0.45)]">
              <Corner className="left-0 top-0 rounded-tl-3xl border-l-4 border-t-4" />
              <Corner className="right-0 top-0 rounded-tr-3xl border-r-4 border-t-4" />
              <Corner className="bottom-0 left-0 rounded-bl-3xl border-b-4 border-l-4" />
              <Corner className="bottom-0 right-0 rounded-br-3xl border-b-4 border-r-4" />
              <span className="absolute inset-x-4 h-0.5 rounded-full bg-brand-300 shadow-[0_0_12px_2px_rgb(127_181_168/0.8)] motion-safe:animate-sweep" />
            </div>
          </div>
        )}

        {state === 'starting' && (
          <div className="absolute inset-0 grid place-items-center">
            <p className="flex items-center gap-2 text-base text-white/85" role="status">
              <SpinnerIcon /> Starting camera…
            </p>
          </div>
        )}

        {state === 'blocked' && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <p role="alert" className="rounded-2xl bg-white/10 p-4 text-center text-base text-white/90">
              {blockedText}
            </p>
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        <p role="status" aria-live="polite" className="min-h-6 text-center text-sm text-white/85">
          {notice || (state === 'scanning' ? 'Point your camera at the QR code on your table.' : '')}
        </p>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPhoto} className="sr-only" tabIndex={-1} aria-label="Choose a photo of the QR code" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={decodingPhoto}
          className="focus-on-dark flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white/15 px-5 text-base font-semibold text-white hover:bg-white/25 disabled:opacity-60"
        >
          {decodingPhoto ? <SpinnerIcon /> : <ImageIcon className="size-5" />}
          {decodingPhoto ? 'Reading photo…' : 'Use a photo of the QR code'}
        </button>
        <button type="button" onClick={onClose} className="focus-on-dark min-h-11 w-full rounded-2xl text-base font-semibold text-white/85 hover:bg-white/10">
          Paste the link instead
        </button>
      </div>
    </div>
  );
}
