'use client';

import { RefObject } from 'react';

interface LiveWatchModalProps {
  videoRef: RefObject<HTMLVideoElement>;
  isConnecting: boolean;
  isStreaming: boolean;
  employeeName: string;
  connectionState: string;
  error: string | null;
  isEnlarged: boolean;
  isRecording: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onFullscreen: () => void;
}

const COLORS = {
  panel: '#FFFFFF',
  panelSoft: '#F7F8FB',
  border: 'rgba(10,10,10,.10)',
  text: '#0A0A0A',
  textMuted: 'rgba(10,10,10,.58)',
  blue: '#0050B0',
  blueSoft: 'rgba(0,80,176,.08)',
  gold: '#B54708',
  goldSoft: 'rgba(181,71,8,.10)',
  green: '#067647',
  greenSoft: 'rgba(6,118,71,.10)',
  red: '#B42318',
  redSoft: 'rgba(180,35,24,.08)',
};

export function LiveWatchModal({
  videoRef,
  isConnecting,
  isStreaming,
  employeeName,
  connectionState,
  error,
  isEnlarged,
  isRecording,
  onClose,
  onRefresh,
  onStartRecording,
  onStopRecording,
  onFullscreen,
}: LiveWatchModalProps) {
  const statusColor = isStreaming ? COLORS.green : isConnecting ? COLORS.blue : COLORS.gold;
  const statusBackground = isStreaming ? COLORS.greenSoft : isConnecting ? COLORS.blueSoft : COLORS.goldSoft;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,.45)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: isEnlarged ? '84vw' : 980,
          height: isEnlarged ? '88vh' : 680,
          maxWidth: '96vw',
          maxHeight: '92vh',
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 24,
          boxShadow: '0 32px 80px rgba(15,23,42,.22)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width .25s ease, height .25s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 18px',
            borderBottom: `1px solid ${COLORS.border}`,
            flexShrink: 0,
            background: COLORS.panel,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: statusColor,
                display: 'inline-block',
              }}
            />
            <span style={{ fontSize: 16, fontWeight: 800, color: COLORS.text }}>{employeeName}</span>
            <span
              style={{
                fontSize: 11,
                color: statusColor,
                background: statusBackground,
                border: `1px solid ${statusBackground}`,
                borderRadius: 999,
                padding: '5px 9px',
                fontWeight: 700,
                letterSpacing: '.02em',
                textTransform: 'uppercase',
              }}
            >
              {connectionState}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 36,
              height: 36,
              borderRadius: 12,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.panelSoft,
              color: COLORS.text,
              fontSize: 18,
              lineHeight: 1,
              cursor: 'pointer',
            }}
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div
          onClick={onFullscreen}
          title={isEnlarged ? 'Click to shrink' : 'Click to expand'}
          style={{
            flex: 1,
            position: 'relative',
            background: '#09111F',
            cursor: 'pointer',
            minHeight: 0,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />

          {!isStreaming && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                color: 'rgba(255,255,255,.86)',
                fontSize: 13,
                background: 'linear-gradient(180deg, rgba(9,17,31,.48), rgba(9,17,31,.78))',
                textAlign: 'center',
                padding: 24,
              }}
            >
              <strong style={{ fontSize: 16, fontWeight: 700 }}>
                {isConnecting ? 'Connecting to live session...' : 'Live session unavailable'}
              </strong>
              <span style={{ maxWidth: 420 }}>
                {isConnecting ? 'Please wait while the employee stream is prepared.' : (error || 'Waiting for an active screen stream.')}
              </span>
            </div>
          )}

          <div
            style={{
              position: 'absolute',
              top: 16,
              left: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: isStreaming ? 'rgba(255,255,255,.96)' : 'rgba(9,17,31,.78)',
              color: isStreaming ? COLORS.green : '#FFFFFF',
              border: isStreaming ? `1px solid ${COLORS.border}` : '1px solid rgba(255,255,255,.12)',
              borderRadius: 999,
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: isStreaming ? COLORS.green : '#FFFFFF',
                display: 'inline-block',
              }}
            />
            {isStreaming ? 'Live' : isConnecting ? 'Connecting' : 'Standby'}
          </div>

          <div
            style={{
              position: 'absolute',
              right: 16,
              bottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255,255,255,.94)',
              color: COLORS.text,
              border: `1px solid rgba(255,255,255,.7)`,
              borderRadius: 999,
              padding: '7px 12px',
              boxShadow: '0 12px 24px rgba(0,0,0,.18)',
              fontSize: 11,
            }}
          >
            <strong>{isEnlarged ? 'Expanded view' : 'Standard view'}</strong>
            <span style={{ color: COLORS.textMuted }}>{isEnlarged ? 'Click to shrink' : 'Click to expand'}</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 18px',
            borderTop: `1px solid ${COLORS.border}`,
            flexShrink: 0,
            background: COLORS.panel,
          }}
        >
          <div style={{ fontSize: 12, color: error ? COLORS.red : COLORS.textMuted }}>
            {error || 'Session controls are available while monitoring this employee.'}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onRefresh();
              }}
              style={{
                padding: '10px 14px',
                borderRadius: 12,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.panelSoft,
                color: COLORS.text,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Refresh stream
            </button>
            {isRecording ? (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onStopRecording();
                }}
                style={{
                  padding: '10px 14px',
                  borderRadius: 12,
                  border: `1px solid ${COLORS.red}`,
                  background: COLORS.redSoft,
                  color: COLORS.red,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Stop recording
              </button>
            ) : (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onStartRecording();
                }}
                disabled={!isStreaming}
                style={{
                  padding: '10px 14px',
                  borderRadius: 12,
                  border: `1px solid ${COLORS.blue}`,
                  background: COLORS.blue,
                  color: '#FFFFFF',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: isStreaming ? 'pointer' : 'not-allowed',
                  opacity: isStreaming ? 1 : 0.5,
                }}
              >
                Start recording
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
