import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ensureAnonymousAuth } from '../firebase/auth';
import { watchPublicShow, type PublicShow } from '../firebase/shows';
import { watchSportsGame, getSportsLightColor, type SportsGame } from '../firebase/sportsGame';
import { watchSportsInteractions, submitSportsResponse, hasRespondedToInteraction, type SportsInteraction } from '../firebase/sports';
import { registerParticipant } from '../firebase/participants';
import { getLightStateAtTime, getNextLightEvent, type LightTimeline } from '../lightSync/timeline';
import { serverNow, watchServerTimeOffset } from '../firebase/serverTime';
import { getReadableTextColor } from '../utils/color';
import { useLanguage, useTranslate, type Language } from '../i18n/LanguageContext';

type TorchConstraints = MediaTrackConstraintSet & { torch?: boolean };
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

type NoticeKey = 'invalid-link' | 'not-found' | 'connect-failed' | 'flash-control-failed' | 'torch-unsupported' | 'torch-unavailable' | 'torch-no-camera-api' | 'join-failed' | 'choose-answer-first' | 'enter-answer-first' | 'response-submitted' | 'already-responded' | 'submit-failed';
type Notice = { key: NoticeKey; detail?: string; isError: boolean } | null;

const NOTICE_TEXT: Record<NoticeKey, Record<Language, string>> = {
  'invalid-link': { tr: 'Geçersiz etkinlik bağlantısı.', en: 'Invalid show link.' },
  'not-found': { tr: 'Etkinlik bulunamadı.', en: 'Show not found.' },
  'connect-failed': { tr: "FanCourt360'a bağlanılamadı. Lütfen sayfayı yenileyin.", en: 'Could not connect to FanCourt360. Please refresh.' },
  'flash-control-failed': { tr: 'Tarayıcınız fener ışığını kontrol edemedi.', en: 'Your browser could not control the flashlight.' },
  'torch-unsupported': { tr: 'Telefonunuz ışık için ekranını kullanacak - bu cihaz/tarayıcıda kamera feneri kontrolü desteklenmiyor.', en: 'Your phone will use its screen as the light - camera flash control is not supported on this device/browser.' },
  'torch-unavailable': { tr: 'Telefonunuz ışık için ekranını kullanacak - kameraya erişilemedi.', en: 'Your phone will use its screen as the light - camera access was unavailable.' },
  'torch-no-camera-api': { tr: 'Telefonunuz bu tarayıcıda ışık için ekranını kullanacak.', en: 'Your phone will use its screen as the light on this browser.' },
  'join-failed': { tr: 'Etkinliğe katılınamadı. Lütfen bağlantınızı kontrol edip tekrar deneyin.', en: 'Could not join the show. Please check your connection and try again.' },
  'choose-answer-first': { tr: 'Önce bir cevap seçin.', en: 'Choose an answer first.' },
  'enter-answer-first': { tr: 'Önce bir cevap yazın.', en: 'Enter an answer first.' },
  'response-submitted': { tr: 'Cevabınız gönderildi!', en: 'Response submitted!' },
  'already-responded': { tr: 'Bu soruyu zaten cevapladınız.', en: 'You already responded to this one.' },
  'submit-failed': { tr: 'Cevabınız gönderilemedi. Lütfen tekrar deneyin.', en: 'Could not submit your answer. Please try again.' },
};

export default function Join() {
  const navigate = useNavigate();
  const { eventId } = useParams();
  const { language, toggleLanguage } = useLanguage();
  const t = useTranslate();
  function noticeText(notice: Notice): string { if (!notice) return ''; if (notice.key === 'join-failed' && notice.detail) return t({ tr: `Etkinliğe katılınamadı: ${notice.detail}`, en: `Could not join the show: ${notice.detail}` }); return NOTICE_TEXT[notice.key][language]; }
  const [event, setEvent] = useState<PublicShow | null>(null); const [game, setGame] = useState<SportsGame | null>(null); const [activeInteraction, setActiveInteraction] = useState<SportsInteraction | null>(null); const [loaded, setLoaded] = useState(false); const [joined, setJoined] = useState(false); const [notice, setNotice] = useState<Notice>(null); const [lightState, setLightState] = useState(false); const [selectedOption, setSelectedOption] = useState(''); const [answer, setAnswer] = useState(''); const [message, setMessage] = useState<Notice>(null); const [sending, setSending] = useState(false); const [submittedInteractionId, setSubmittedInteractionId] = useState<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null); const nextTimerRef = useRef<number | null>(null); const currentLightRef = useRef(false); const flashCommandRef = useRef(0);
  useEffect(() => watchServerTimeOffset(() => {}), []);
  useEffect(() => { if (!eventId) { setLoaded(true); setNotice({ key: 'invalid-link', isError: true }); return; } const showId = eventId; let cancelled = false; let stopShow: (() => void) | undefined; let stopGame: (() => void) | undefined; let stopInteractions: (() => void) | undefined; async function connect() { try { await ensureAnonymousAuth(); if (cancelled) return; stopShow = watchPublicShow(showId, show => { if (cancelled) return; setEvent(show); setLoaded(true); if (!show) setNotice({ key: 'not-found', isError: true }); }); stopGame = watchSportsGame(showId, setGame); stopInteractions = watchSportsInteractions(showId, items => setActiveInteraction(items.find(item => item.status === 'open') ?? null)); } catch (err) { console.error(err); if (!cancelled) { setLoaded(true); setNotice({ key: 'connect-failed', isError: true }); } } } void connect(); return () => { cancelled = true; stopShow?.(); stopGame?.(); stopInteractions?.(); }; }, [eventId]);
  useEffect(() => { setSelectedOption(''); setAnswer(''); setMessage(null); setSending(false); setSubmittedInteractionId(null); if (!eventId || !activeInteraction) return; let cancelled = false; const interactionId = activeInteraction.id; void (async () => { try { const uid = (await ensureAnonymousAuth()).uid; const already = await hasRespondedToInteraction(eventId, interactionId, uid); if (!cancelled && already) setSubmittedInteractionId(interactionId); } catch (err) { console.error(err); } })(); return () => { cancelled = true; }; }, [eventId, activeInteraction?.id]);
  function clearNextTimer() { if (nextTimerRef.current !== null) window.clearTimeout(nextTimerRef.current); nextTimerRef.current = null; }
  function setFlash(enabled: boolean) {
    const commandId = ++flashCommandRef.current;
    if (currentLightRef.current === enabled) return;

    // Update the screen immediately. Do NOT wait for the camera torch API:
    // applyConstraints() can take tens/hundreds of milliseconds and used to
    // delay the visible screen flash by exactly that amount.
    currentLightRef.current = enabled;
    setLightState(enabled);

    const track = trackRef.current;
    if (!track) return;

    void track.applyConstraints({ advanced: [{ torch: enabled } as TorchConstraints] })
      .catch(err => {
        console.error(err);
        if (commandId === flashCommandRef.current) {
          setNotice({ key: 'flash-control-failed', isError: true });
        }
      });
  }
  function scheduleNextEvent(timeline: LightTimeline, start: number, offsetMs: number) {
    clearNextTimer();
    const now = serverNow();
    if (now < start) {
      nextTimerRef.current = window.setTimeout(() => synchronizeShow(start, timeline, offsetMs / 1000), Math.max(0, start - now));
      return;
    }
    const position = now - start + offsetMs;
    const next = getNextLightEvent(timeline, position);
    if (!next) return;
    const eventAt = start + next.time - offsetMs;
    // Recalculate against the shared server clock every cycle. This avoids
    // cumulative drift from chained setTimeout() delays.
    nextTimerRef.current = window.setTimeout(() => {
      const currentPosition = serverNow() - start + offsetMs;
      setFlash(getLightStateAtTime(timeline, currentPosition));
      scheduleNextEvent(timeline, start, offsetMs);
    }, Math.max(0, eventAt - now));
  }
  function synchronizeShow(start: number, timeline: LightTimeline, offsetSeconds = 0) {
    const offsetMs = Math.max(0, offsetSeconds) * 1000;
    const now = serverNow();
    const position = now >= start ? now - start + offsetMs : -1;
    setFlash(position >= 0 ? getLightStateAtTime(timeline, position) : false);
    scheduleNextEvent(timeline, start, offsetSeconds);
  }
  async function joinShow() { if (!eventId || !event) return; setNotice(null); let torchNotice: Notice = null; if (navigator.mediaDevices?.getUserMedia) { try { const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); const track = stream.getVideoTracks()[0]; const capabilities = track?.getCapabilities?.() as TorchCapabilities | undefined; if (track && capabilities?.torch) trackRef.current = track; else { stream.getTracks().forEach(track => track.stop()); torchNotice = { key: 'torch-unsupported', isError: false }; } } catch (mediaErr) { console.error(mediaErr); torchNotice = { key: 'torch-unavailable', isError: false }; } } else torchNotice = { key: 'torch-no-camera-api', isError: false }; try { const user = await ensureAnonymousAuth(); await registerParticipant(eventId, user.uid); setJoined(true); if (torchNotice) setNotice(torchNotice); if (event.status === 'running' && event.showStartTime && event.lightTimeline) synchronizeShow(event.showStartTime, event.lightTimeline as LightTimeline, event.showStartOffset ?? 0); } catch (err) { console.error(err); const reason = err instanceof Error ? err.message : ''; setNotice({ key: 'join-failed', detail: reason || undefined, isError: true }); } }
  async function submitInteraction() { if (!eventId || !activeInteraction || sending) return; if (activeInteraction.type === 'poll' && !selectedOption) { setMessage({ key: 'choose-answer-first', isError: true }); return; } if (activeInteraction.type === 'question' && !answer.trim()) { setMessage({ key: 'enter-answer-first', isError: true }); return; } const interactionId = activeInteraction.id; setSending(true); setMessage(null); try { const uid = (await ensureAnonymousAuth()).uid; await submitSportsResponse(eventId, interactionId, uid, activeInteraction.type === 'poll' ? { optionId: selectedOption } : { answer: answer.trim().slice(0, 200) }); setSubmittedInteractionId(interactionId); setMessage({ key: 'response-submitted', isError: false }); setSelectedOption(''); setAnswer(''); } catch (err) { console.error(err); const alreadyResponded = err instanceof Error && /permission/i.test(err.message); if (alreadyResponded) { setSubmittedInteractionId(interactionId); setMessage({ key: 'already-responded', isError: false }); } else setMessage({ key: 'submit-failed', isError: true }); } finally { setSending(false); } }
  useEffect(() => { if (!joined || !event) return; if (event.status === 'running' && event.showStartTime && event.lightTimeline) synchronizeShow(event.showStartTime, event.lightTimeline as LightTimeline, event.showStartOffset ?? 0); else { clearNextTimer(); setFlash(false); } }, [joined, event?.status, event?.showStartTime, event?.showStartOffset, event?.lightTimeline]);
  useEffect(() => { if (!joined) return; const resync = () => { if (document.visibilityState !== 'visible' || !event) return; if (event.status === 'running' && event.showStartTime && event.lightTimeline) synchronizeShow(event.showStartTime, event.lightTimeline as LightTimeline, event.showStartOffset ?? 0); else { clearNextTimer(); void setFlash(false); } }; document.addEventListener('visibilitychange', resync); window.addEventListener('pageshow', resync); window.addEventListener('focus', resync); return () => { document.removeEventListener('visibilitychange', resync); window.removeEventListener('pageshow', resync); window.removeEventListener('focus', resync); }; }, [joined, event?.status, event?.showStartTime, event?.showStartOffset, event?.lightTimeline]);
  useEffect(() => () => { clearNextTimer(); flashCommandRef.current += 1; setLightState(false); if (trackRef.current) { void trackRef.current.applyConstraints({ advanced: [{ torch: false } as TorchConstraints] }).catch(() => {}); trackRef.current.stop(); } }, []);
  const langToggle = <button type="button" className="light-lang-toggle" onClick={toggleLanguage} aria-label="Switch language">{language === 'tr' ? 'EN' : 'TR'}</button>;
  if (!loaded) return <main className="light-page light-page-loading"><div className="light-shell"><div className="light-header"><div className="light-brand">FANCOURT360</div>{langToggle}</div><div className="light-loading ls-mobile-loading"><span className="ls-mobile-pulse-dot" />{t({ tr: 'Etkinliğe bağlanılıyor...', en: 'Connecting to show...' })}</div></div></main>;
  if (!event || !eventId) return <main className="light-page light-page-loading"><div className="light-shell"><div className="light-header"><div className="light-brand">FANCOURT360</div>{langToggle}</div><div className="light-loading">{notice ? noticeText(notice) : t({ tr: 'Etkinlik bulunamadı.', en: 'Show not found.' })}</div><button className="light-primary-button" onClick={() => navigate('/')}>{t({ tr: 'GERİ', en: 'BACK' })}</button></div></main>;
  const uiColor = event.phoneUiColor && /^#[0-9a-fA-F]{6}$/.test(event.phoneUiColor) ? event.phoneUiColor : getSportsLightColor(game); const flashColor = event.screenLightColor && /^#[0-9a-fA-F]{6}$/.test(event.screenLightColor) ? event.screenLightColor : uiColor; const running = event.status === 'running'; const alreadyResponded = !!activeInteraction && submittedInteractionId === activeInteraction.id; const pageBackground = lightState ? flashColor : `radial-gradient(circle at 50% 0%, ${uiColor}55 0%, transparent 42%), linear-gradient(160deg, #101218 0%, #08090d 58%, #050507 100%)`; const choiceInk = getReadableTextColor(uiColor);
  const interactionCard = activeInteraction ? <section className="light-interaction" aria-live="polite"><div className="interaction-header"><span className="interaction-live-dot" /><span>{activeInteraction.type === 'poll' ? t({ tr: 'CANLI ANKET', en: 'LIVE POLL' }) : t({ tr: 'CANLI SORU', en: 'LIVE QUESTION' })}</span></div><div className="interaction-question">{activeInteraction.question}</div>{alreadyResponded ? <div className="interaction-message">{message ? noticeText(message) : t({ tr: 'Bu soruyu zaten cevapladınız.', en: 'You already responded to this one.' })}</div> : <>{activeInteraction.type === 'poll' ? <div className="interaction-options">{Object.entries(activeInteraction.options ?? {}).map(([id, label]) => <button key={id} type="button" className={`interaction-option ${selectedOption === id ? 'is-selected' : ''}`} disabled={sending} onClick={() => { setSelectedOption(id); setMessage(null); }} style={selectedOption === id ? ({ '--choice-color': uiColor, '--choice-ink': choiceInk } as CSSProperties) : undefined}><span>{label}</span><span className="choice-mark">{selectedOption === id ? '✓' : ''}</span></button>)}</div> : <textarea className="interaction-answer" value={answer} onChange={e => { setAnswer(e.target.value); setMessage(null); }} maxLength={200} placeholder={t({ tr: 'Cevabınızı yazın...', en: 'Type your answer...' })} rows={3} />}<button type="button" className="interaction-submit" disabled={sending} onClick={() => void submitInteraction()} style={{ background: uiColor, color: getReadableTextColor(uiColor) }}>{sending ? t({ tr: 'GÖNDERİLİYOR...', en: 'SUBMITTING...' }) : activeInteraction.type === 'poll' ? t({ tr: 'OYU GÖNDER', en: 'SUBMIT VOTE' }) : t({ tr: 'CEVABI GÖNDER', en: 'SUBMIT ANSWER' })}</button>{message && <div className={`interaction-message ${message.isError ? 'is-error' : ''}`}>{noticeText(message)}</div>}</>}</section> : null;
  if (!joined) return <main className="light-page" style={{ background: pageBackground, '--phone-accent': uiColor, '--flash-accent': flashColor } as CSSProperties}><div className="light-shell light-shell-join"><header className="light-header"><div className="light-brand">FANCOURT360</div><div className="light-header-right">{langToggle}<div className="light-status"><span /> {t({ tr: 'SİSTEM HAZIR', en: 'SYSTEM READY' })}</div></div></header><section className="light-main join-main"><div className="light-kicker">{event.name}</div><h1>{t({ tr: 'Telefonunuzu ışığa katın.', en: 'Turn your phone into light.' })}</h1><p>{t({ tr: 'Gösteri başladığında ekranınız etkinliğin ritmine göre senkronize olacaktır.', en: 'When the show starts, your screen will sync to the rhythm of the event.' })}</p>{notice && <div className={`light-notice ${notice.isError ? 'is-error' : ''}`}>{noticeText(notice)}</div>}<button className="light-primary-button ls-mobile-cta" onClick={() => void joinShow()}>{t({ tr: 'ETKİNLİĞE KATIL', en: 'JOIN THE SHOW' })}</button></section></div></main>;
  return <main className="light-page" style={{ background: pageBackground, '--phone-accent': uiColor, '--flash-accent': flashColor } as CSSProperties}><div className="light-shell"><header className="light-header"><div className="light-brand">FANCOURT360</div><div className="light-header-right">{langToggle}<div className="light-status"><span /> {running ? t({ tr: 'CANLI', en: 'LIVE' }) : t({ tr: 'HAZIR', en: 'READY' })}</div></div></header><section className="light-main fc-audience-main">
      <div className="fc-audience-event">{event.name}</div>
      {notice && <div className={`light-notice ${notice.isError ? 'is-error' : ''}`}>{noticeText(notice)}</div>}
      {interactionCard}
      {!running && !activeInteraction && <div className="light-waiting ls-mobile-waiting fc-audience-state"><div className="fc-off-orb" aria-hidden="true" /><h1>{t({ tr: 'GÖSTERİ KAPALI', en: 'SHOW OFF' })}</h1><p>{t({ tr: 'Organizatör gösteriyi başlattığında burada olacaksınız.', en: 'You will see the show here when the organizer starts it.' })}</p></div>}
      {running && !activeInteraction && <div className={`light-state fc-audience-state ${lightState ? 'is-flashing' : ''}`}><div className="fc-light-orb" aria-hidden="true"><span /></div><h1>{t({ tr: 'GÖSTERİ AÇIK', en: 'SHOW ON' })}</h1><p>{t({ tr: 'Telefonunuzu açık tutun ve gösterinin tadını çıkarın.', en: 'Keep your phone open and enjoy the show.' })}</p></div>}
      <div className="fc-audience-footer">{running ? t({ tr: 'EKRANI AÇIK TUTUN', en: 'KEEP SCREEN ON' }) : t({ tr: 'FANCOURT360 • CANLI ETKİNLİK', en: 'FANCOURT360 • LIVE EVENT' })}</div>
    </section></div></main>;
}