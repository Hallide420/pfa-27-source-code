/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { PlayerProfile, FlickStyle, PenDefinition } from '../types/game';
import { PENS_CATALOG, FLICK_STYLES } from '../data/initialData';
import { stepPhysics, DeskBounds, distance, normalize } from '../physics/penPhysics';
import { sounds } from '../utils/audio';
import { triggerHaptic, detectDevicePlatform } from '../utils/device';
import {
  GraduationCap,
  Target,
  Scale,
  Gauge,
  RotateCw,
  Package,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  Sparkles,
  ShieldCheck,
  Zap,
  Play,
  X
} from 'lucide-react';

interface TutorialAcademyProps {
  profile: PlayerProfile;
  onCompleteTutorial: () => void;
  onExit: () => void;
}

interface InteractiveEntity {
  id: string;
  type: 'pen' | 'target' | 'obstacle';
  name: string;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  angle: number;
  angularVel: number;
  stats: {
    mass: number;
    length: number;
    width: number;
    friction: number;
    powerMultiplier: number;
    spinMultiplier: number;
    material?: string;
  };
  color: string;
  accentColor: string;
  isKnockedOut: boolean;
  isHit?: boolean;
}

const DESK_WIDTH = 840;
const DESK_HEIGHT = 480;
const TABLE_BOUNDS: DeskBounds = {
  x: 45,
  y: 35,
  width: DESK_WIDTH - 90,
  height: DESK_HEIGHT - 70,
};

export const TutorialAcademy: React.FC<TutorialAcademyProps> = ({
  profile,
  onCompleteTutorial,
  onExit,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [stepSuccess, setStepSuccess] = useState<boolean>(false);
  const [activePenId, setActivePenId] = useState<string>('bic_cristal');
  const [curveModifier, setCurveModifier] = useState<number>(0);
  const [selectedStyle, setSelectedStyle] = useState<FlickStyle>(FLICK_STYLES[0]);
  const [hasClaimedReward, setHasClaimedReward] = useState<boolean>(false);
  const [unboxingRevealed, setUnboxingRevealed] = useState<boolean>(false);

  // Canvas and physics refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entitiesRef = useRef<InteractiveEntity[]>([]);
  const isSimulatingRef = useRef<boolean>(false);
  const lastPowerBracketRef = useRef<number>(-1);
  const [aimState, setAimState] = useState<{
    isAiming: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };
    powerNormalized: number;
    angle: number;
  }>({
    isAiming: false,
    startPos: { x: 0, y: 0 },
    currentPos: { x: 0, y: 0 },
    powerNormalized: 0,
    angle: 0,
  });

  const isMobile = detectDevicePlatform() === 'mobile';

  // Setup entities according to current stage
  const resetStage = useCallback(
    (stepIndex: number, penIdOverride?: string) => {
      const penDef =
        PENS_CATALOG.find((p) => p.id === (penIdOverride || activePenId)) || PENS_CATALOG[0];

      setStepSuccess(false);
      isSimulatingRef.current = false;

      if (stepIndex === 0) {
        // Stage 1: Basic Aiming (Direct Target Eraser)
        entitiesRef.current = [
          {
            id: 'player_pen',
            type: 'pen',
            name: penDef.name,
            pos: { x: 180, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: 0,
            angularVel: 0,
            stats: { ...penDef.stats },
            color: penDef.baseColor,
            accentColor: penDef.tipColor,
            isKnockedOut: false,
          },
          {
            id: 'target_eraser',
            type: 'target',
            name: 'School Eraser',
            pos: { x: 580, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: 0,
            angularVel: 0,
            stats: {
              mass: 0.8,
              length: 44,
              width: 32,
              friction: 0.024,
              powerMultiplier: 1.0,
              spinMultiplier: 1.0,
            },
            color: '#ef4444',
            accentColor: '#ffffff',
            isKnockedOut: false,
            isHit: false,
          },
        ];
      } else if (stepIndex === 1) {
        // Stage 2: Mass & Impulse (Bic 5.8g vs Rotring 23.5g)
        const currentPen =
          PENS_CATALOG.find((p) => p.id === (penIdOverride || activePenId)) || PENS_CATALOG[0];
        entitiesRef.current = [
          {
            id: 'player_pen',
            type: 'pen',
            name: currentPen.name,
            pos: { x: 180, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: 0,
            angularVel: 0,
            stats: { ...currentPen.stats },
            color: currentPen.baseColor,
            accentColor: currentPen.tipColor,
            isKnockedOut: false,
          },
          {
            id: 'heavy_sharpener',
            type: 'target',
            name: 'Metal Sharpener',
            pos: { x: 550, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: 0,
            angularVel: 0,
            stats: {
              mass: 1.6,
              length: 40,
              width: 28,
              friction: 0.03,
              powerMultiplier: 0.9,
              spinMultiplier: 1.0,
            },
            color: '#94a3b8',
            accentColor: '#38bdf8',
            isKnockedOut: false,
            isHit: false,
          },
        ];
      } else if (stepIndex === 2) {
        // Stage 3: Power Control & Edge Braking (Don't fall off!)
        const bicDef = PENS_CATALOG[0];
        entitiesRef.current = [
          {
            id: 'player_pen',
            type: 'pen',
            name: bicDef.name,
            pos: { x: 260, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: 0,
            angularVel: 0,
            stats: { ...bicDef.stats },
            color: bicDef.baseColor,
            accentColor: bicDef.tipColor,
            isKnockedOut: false,
          },
          {
            id: 'perched_rival',
            type: 'target',
            name: 'Edge Perched Rival',
            pos: { x: TABLE_BOUNDS.x + TABLE_BOUNDS.width - 55, y: DESK_HEIGHT / 2 },
            vel: { x: 0, y: 0 },
            angle: Math.PI / 2,
            angularVel: 0,
            stats: {
              mass: 0.7,
              length: 80,
              width: 14,
              friction: 0.019,
              powerMultiplier: 1.0,
              spinMultiplier: 1.2,
            },
            color: '#fbbf24',
            accentColor: '#b45309',
            isKnockedOut: false,
            isHit: false,
          },
        ];
      } else if (stepIndex === 3) {
        // Stage 4: Spin & Curve (Obstacle In Between)
        const pilotDef = PENS_CATALOG[1] || PENS_CATALOG[0];
        entitiesRef.current = [
          {
            id: 'player_pen',
            type: 'pen',
            name: pilotDef.name,
            pos: { x: 160, y: DESK_HEIGHT / 2 + 50 },
            vel: { x: 0, y: 0 },
            angle: -0.2,
            angularVel: 0,
            stats: { ...pilotDef.stats },
            color: pilotDef.baseColor,
            accentColor: pilotDef.tipColor,
            isKnockedOut: false,
          },
          {
            id: 'obstacle_ruler',
            type: 'obstacle',
            name: 'Stationary Ruler',
            pos: { x: 380, y: DESK_HEIGHT / 2 + 30 },
            vel: { x: 0, y: 0 },
            angle: 0.2,
            angularVel: 0,
            stats: {
              mass: 12.0,
              length: 120,
              width: 26,
              friction: 0.1,
              powerMultiplier: 0.2,
              spinMultiplier: 0.1,
            },
            color: '#64748b',
            accentColor: '#334155',
            isKnockedOut: false,
          },
          {
            id: 'hidden_target',
            type: 'target',
            name: 'Flanked Rival',
            pos: { x: 620, y: DESK_HEIGHT / 2 - 30 },
            vel: { x: 0, y: 0 },
            angle: Math.PI / 4,
            angularVel: 0,
            stats: {
              mass: 0.75,
              length: 70,
              width: 14,
              friction: 0.02,
              powerMultiplier: 1.0,
              spinMultiplier: 1.1,
            },
            color: '#a855f7',
            accentColor: '#e9d5ff',
            isKnockedOut: false,
            isHit: false,
          },
        ];
      }
    },
    [activePenId]
  );

  useEffect(() => {
    resetStage(currentStep);
  }, [currentStep, resetStage]);

  // Execute physics flick on the player's pen
  const executeFlick = useCallback(
    (power: number, angle: number, curve: number, style: FlickStyle) => {
      const pen = entitiesRef.current.find((e) => e.id === 'player_pen');
      if (!pen || pen.isKnockedOut) return;

      const baseImpulse = 18.0 * style.powerBonus * power;
      const speed = (baseImpulse / pen.stats.mass) * pen.stats.powerMultiplier;

      pen.vel.x = Math.cos(angle) * speed;
      pen.vel.y = Math.sin(angle) * speed;

      const baseTorque = curve * 8.0 * style.spinBonus * pen.stats.spinMultiplier;
      pen.angularVel = baseTorque / Math.max(0.6, pen.stats.mass * 0.8);

      sounds.playFlick(power);
      triggerHaptic('medium');
      isSimulatingRef.current = true;
    },
    []
  );

  // Main canvas animation & collision loop
  useEffect(() => {
    let animationFrameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      // 1. Step simulation
      if (isSimulatingRef.current) {
        let movingCount = 0;

        for (const entity of entitiesRef.current) {
          if (entity.isKnockedOut) continue;

          // Apply velocity
          entity.pos.x += entity.vel.x;
          entity.pos.y += entity.vel.y;
          entity.angle += entity.angularVel;

          // Apply friction
          const speed = Math.hypot(entity.vel.x, entity.vel.y);
          if (speed > 0.05) {
            const frictionDecel = entity.stats.friction * 9.8;
            const newSpeed = Math.max(0, speed - frictionDecel * 0.35);
            const ratio = newSpeed / speed;
            entity.vel.x *= ratio;
            entity.vel.y *= ratio;
            movingCount++;
          } else {
            entity.vel.x = 0;
            entity.vel.y = 0;
          }

          // Angular drag
          if (Math.abs(entity.angularVel) > 0.005) {
            entity.angularVel *= 0.96;
            movingCount++;
          } else {
            entity.angularVel = 0;
          }

          // Knockout detection (Table edge perimeter)
          const isOffTable =
            entity.pos.x < TABLE_BOUNDS.x ||
            entity.pos.x > TABLE_BOUNDS.x + TABLE_BOUNDS.width ||
            entity.pos.y < TABLE_BOUNDS.y ||
            entity.pos.y > TABLE_BOUNDS.y + TABLE_BOUNDS.height;

          if (isOffTable && !entity.isKnockedOut) {
            entity.isKnockedOut = true;
            sounds.playKnockout();
            triggerHaptic('heavy');
          }
        }

        // Entity-to-entity rigid body collisions (simple circle-capsule solver)
        for (let i = 0; i < entitiesRef.current.length; i++) {
          for (let j = i + 1; j < entitiesRef.current.length; j++) {
            const e1 = entitiesRef.current[i];
            const e2 = entitiesRef.current[j];
            if (e1.isKnockedOut || e2.isKnockedOut) continue;

            const dx = e2.pos.x - e1.pos.x;
            const dy = e2.pos.y - e1.pos.y;
            const dist = Math.hypot(dx, dy);
            const minDist = (e1.stats.width + e2.stats.width) / 1.4;

            if (dist < minDist && dist > 0.001) {
              // Collision registered
              const nx = dx / dist;
              const ny = dy / dist;

              // Separate
              const overlap = minDist - dist;
              e1.pos.x -= nx * overlap * 0.5;
              e1.pos.y -= ny * overlap * 0.5;
              e2.pos.x += nx * overlap * 0.5;
              e2.pos.y += ny * overlap * 0.5;

              // Elastic momentum exchange
              const kx = e1.vel.x - e2.vel.x;
              const ky = e1.vel.y - e2.vel.y;
              const p = 2 * (nx * kx + ny * ky) / (e1.stats.mass + e2.stats.mass);

              e1.vel.x -= p * e2.stats.mass * nx;
              e1.vel.y -= p * e2.stats.mass * ny;
              e2.vel.x += p * e1.stats.mass * nx;
              e2.vel.y += p * e1.stats.mass * ny;

              // Angular impulse from impact
              e1.angularVel += (Math.random() - 0.5) * 0.25;
              e2.angularVel += (Math.random() - 0.5) * 0.25;

              sounds.playClack();
              triggerHaptic('light');

              if (e2.type === 'target') e2.isHit = true;
              if (e1.type === 'target') e1.isHit = true;
            }
          }
        }

        // Check stage success conditions once objects settle
        if (movingCount === 0) {
          isSimulatingRef.current = false;
          const playerPen = entitiesRef.current.find((e) => e.id === 'player_pen');
          const target = entitiesRef.current.find((e) => e.type === 'target');

          if (currentStep === 0) {
            // Stage 1: Hit the target eraser
            if (target && target.isHit) {
              setStepSuccess(true);
              sounds.playPaperclipReward();
              triggerHaptic('medium');
            }
          } else if (currentStep === 1) {
            // Stage 2: Heavy sharpener test
            if (target && (target.isHit || target.isKnockedOut)) {
              setStepSuccess(true);
              sounds.playPaperclipReward();
              triggerHaptic('medium');
            }
          } else if (currentStep === 2) {
            // Stage 3: Edge knockout without player falling off
            if (target && target.isKnockedOut && playerPen && !playerPen.isKnockedOut) {
              setStepSuccess(true);
              sounds.playPaperclipReward();
              triggerHaptic('heavy');
            }
          } else if (currentStep === 3) {
            // Stage 4: Curve around obstacle to hit flank target
            if (target && target.isHit && playerPen && !playerPen.isKnockedOut) {
              setStepSuccess(true);
              sounds.playPaperclipReward();
              triggerHaptic('heavy');
            }
          }
        }
      }

      // 2. Draw Desk Background & Perimeter
      ctx.clearRect(0, 0, DESK_WIDTH, DESK_HEIGHT);

      // Desk wood gradient
      const deskGrad = ctx.createLinearGradient(0, 0, 0, DESK_HEIGHT);
      deskGrad.addColorStop(0, '#1c1917');
      deskGrad.addColorStop(0.5, '#0c0a09');
      deskGrad.addColorStop(1, '#1c1917');
      ctx.fillStyle = deskGrad;
      ctx.fillRect(0, 0, DESK_WIDTH, DESK_HEIGHT);

      // School desk graph paper grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x < DESK_WIDTH; x += 30) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, DESK_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0; y < DESK_HEIGHT; y += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(DESK_WIDTH, y);
        ctx.stroke();
      }

      // Table Boundary Line (Knockout Perimeter)
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(TABLE_BOUNDS.x, TABLE_BOUNDS.y, TABLE_BOUNDS.width, TABLE_BOUNDS.height);
      ctx.setLineDash([]);

      // Desk edge danger zone stripes
      ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      ctx.fillRect(0, 0, TABLE_BOUNDS.x, DESK_HEIGHT);
      ctx.fillRect(TABLE_BOUNDS.x + TABLE_BOUNDS.width, 0, DESK_WIDTH - (TABLE_BOUNDS.x + TABLE_BOUNDS.width), DESK_HEIGHT);
      ctx.fillRect(0, 0, DESK_WIDTH, TABLE_BOUNDS.y);
      ctx.fillRect(0, TABLE_BOUNDS.y + TABLE_BOUNDS.height, DESK_WIDTH, DESK_HEIGHT - (TABLE_BOUNDS.y + TABLE_BOUNDS.height));

      // 3. Draw Interactive Entities
      for (const entity of entitiesRef.current) {
        if (entity.isKnockedOut) continue;

        ctx.save();
        ctx.translate(entity.pos.x, entity.pos.y);
        ctx.rotate(entity.angle);

        const halfL = entity.stats.length / 2;
        const halfW = entity.stats.width / 2;

        if (entity.type === 'pen') {
          // Render authentic pen silhouette
          ctx.fillStyle = entity.color;
          ctx.fillRect(-halfL, -halfW, entity.stats.length, entity.stats.width);

          // Pen cap / grip accent
          ctx.fillStyle = entity.accentColor;
          ctx.fillRect(halfL - 14, -halfW, 14, entity.stats.width);
          ctx.fillRect(-halfL, -halfW, 8, entity.stats.width);

          // Outline
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(-halfL, -halfW, entity.stats.length, entity.stats.width);

          // Brand label
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(entity.name.split(' ')[0], 0, 3);
        } else if (entity.type === 'target') {
          // Target eraser / sharpener
          ctx.fillStyle = entity.color;
          ctx.fillRect(-halfL, -halfW, entity.stats.length, entity.stats.width);
          ctx.strokeStyle = entity.isHit ? '#22c55e' : '#ffffff';
          ctx.lineWidth = entity.isHit ? 3 : 2;
          ctx.strokeRect(-halfL, -halfW, entity.stats.length, entity.stats.width);

          // Label
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('TARGET', 0, 3);
        } else if (entity.type === 'obstacle') {
          // Heavy stationery obstacle
          ctx.fillStyle = entity.color;
          ctx.fillRect(-halfL, -halfW, entity.stats.length, entity.stats.width);
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 2;
          ctx.strokeRect(-halfL, -halfW, entity.stats.length, entity.stats.width);

          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('STEEL RULER (OBSTACLE)', 0, 3);
        }

        ctx.restore();
      }

      // 4. Draw Aiming Reticle & Trajectory Forecast
      if (aimState.isAiming) {
        const playerPen = entitiesRef.current.find((e) => e.id === 'player_pen');
        if (playerPen && !playerPen.isKnockedOut) {
          const aimLength = 60 + aimState.powerNormalized * 180;
          const endX = playerPen.pos.x + Math.cos(aimState.angle) * aimLength;
          const endY = playerPen.pos.y + Math.sin(aimState.angle) * aimLength;

          // Trajectory dashed guide line
          ctx.beginPath();
          ctx.moveTo(playerPen.pos.x, playerPen.pos.y);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = '#ffe500';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Aim arrowhead
          ctx.save();
          ctx.translate(endX, endY);
          ctx.rotate(aimState.angle);
          ctx.fillStyle = '#ffe500';
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-12, -7);
          ctx.lineTo(-12, 7);
          ctx.closePath();
          ctx.fill();
          ctx.restore();

          // Drag string line to pointer
          ctx.beginPath();
          ctx.moveTo(playerPen.pos.x, playerPen.pos.y);
          ctx.lineTo(aimState.currentPos.x, aimState.currentPos.y);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Anchor pull ring
          ctx.beginPath();
          ctx.arc(aimState.currentPos.x, aimState.currentPos.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = '#ffe500';
          ctx.fill();
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [aimState, currentStep]);

  // Pointer aiming events
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isSimulatingRef.current || currentStep >= 4) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = DESK_WIDTH / rect.width;
    const scaleY = DESK_HEIGHT / rect.height;
    const startX = (e.clientX - rect.left) * scaleX;
    const startY = (e.clientY - rect.top) * scaleY;

    const playerPen = entitiesRef.current.find((e) => e.id === 'player_pen');
    if (!playerPen || playerPen.isKnockedOut) return;

    sounds.playAimPull();
    triggerHaptic('light');

    setAimState({
      isAiming: true,
      startPos: { x: startX, y: startY },
      currentPos: { x: startX, y: startY },
      powerNormalized: 0.1,
      angle: 0,
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!aimState.isAiming) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = DESK_WIDTH / rect.width;
    const scaleY = DESK_HEIGHT / rect.height;
    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    const dx = currentX - aimState.startPos.x;
    const dy = currentY - aimState.startPos.y;
    const pullDist = Math.hypot(dx, dy);
    const maxPull = 160;

    const powerNormalized = Math.min(1.0, Math.max(0.1, pullDist / maxPull));
    const flickAngle = Math.atan2(-dy, -dx);

    const bracket = Math.floor(powerNormalized * 4);
    if (bracket !== lastPowerBracketRef.current) {
      lastPowerBracketRef.current = bracket;
      triggerHaptic('powerTick');
    }

    setAimState((prev) => ({
      ...prev,
      currentPos: { x: currentX, y: currentY },
      powerNormalized,
      angle: flickAngle,
    }));
  };

  const handlePointerUp = () => {
    if (!aimState.isAiming) return;

    if (aimState.powerNormalized > 0.08) {
      executeFlick(
        aimState.powerNormalized,
        aimState.angle,
        curveModifier,
        selectedStyle
      );
    }

    setAimState({
      isAiming: false,
      startPos: { x: 0, y: 0 },
      currentPos: { x: 0, y: 0 },
      powerNormalized: 0,
      angle: 0,
    });
  };

  // Progression Stage 5: Unbox Academy Starter Tin
  const handleOpenAcademyTin = () => {
    sounds.playPackTear();
    triggerHaptic('heavy');
    setUnboxingRevealed(true);
    sounds.playPackWalkout();
    setStepSuccess(true);
  };

  // Graduation Claim
  const handleGraduateAcademy = () => {
    sounds.playPaperclipReward();
    triggerHaptic('heavy');
    setHasClaimedReward(true);
    onCompleteTutorial();
  };

  // Stage Descriptions & Coaching Guidance
  const STAGES = [
    {
      title: 'LESSON 1: THE AIM LINE & DIRECT TRAJECTORY',
      badge: 'FUNDAMENTALS',
      objective: 'Pull back from anywhere on the desk to aim. Release to flick and strike the red target eraser.',
      tip: 'Pull backward in the opposite direction you want your pen to fly (slingshot mechanic).',
    },
    {
      title: 'LESSON 2: REAL MASS & WEIGHT RATIOS',
      badge: 'RIGID-BODY IMPULSE',
      objective: 'Switch between the 5.8g Bic Cristal (Featherweight) and 23.5g Rotring 600 (Heavyweight). Strike the metal sharpener.',
      tip: 'According to Newton’s 2nd law (v = J / m), light pens fly fast but deflect on impact. Heavy pens carry massive momentum that plows through targets!',
    },
    {
      title: 'LESSON 3: POWER CONTROL & EDGE BRAKING',
      badge: 'SUICIDE PREVENTION',
      objective: 'Knock the rival pen off the desk edge without letting your pen slide over the red dashed boundary!',
      tip: 'Watch the tactile power meter! A medium impulse (40-60%) will knock off the perched rival and brake your pen safely on the desk.',
    },
    {
      title: 'LESSON 4: SPIN TORQUE & CURVE MODIFIERS',
      badge: 'ADVANCED TRICKSHOTS',
      objective: 'Equip the Knuckle Cannon flick style and adjust spin curve to curve around the steel ruler obstacle.',
      tip: 'Curve alters lateral angular momentum (omega = r x J). Curve your shot right or left to bend around obstacles and flank opponents!',
    },
    {
      title: 'LESSON 5: ECONOMY & GEOMETRY VAULT',
      badge: 'PROGRESSION & REWARDS',
      objective: 'Open your complimentary PFA 27 Academy Tin to unlock your graduation paperclips and exclusive pen skin.',
      tip: 'Every victory in Ranked, Tournaments, and Bot Lab awards Paperclips. Spend them in the Geometry Vault to unlock rare pens and collectible skins!',
    },
  ];

  const currentStageInfo = STAGES[currentStep];

  return (
    <div className="w-full max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 font-sans">
      {/* Top Header Card */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 bg-white border-4 border-black p-4 sm:p-5 shadow-brutal-yellow">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#ffe500] text-black border-2 border-black flex items-center justify-center font-black shadow-brutal-black shrink-0">
            <GraduationCap className="w-6 h-6 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="bg-black text-[#ffe500] font-mono font-black text-[10px] px-2 py-0.5 border border-black uppercase tracking-wider">
                PFA 27 TRAINING ACADEMY
              </span>
              <span className="font-mono text-xs font-bold text-neutral-600 uppercase">
                LESSON {currentStep + 1} OF 5
              </span>
            </div>
            <h1 className="font-broadcast text-3xl sm:text-4xl font-black italic tracking-wide text-black mt-1 leading-none">
              {currentStageInfo.title}
            </h1>
          </div>
        </div>

        {/* Exit & Lesson Stepper */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-neutral-100 p-1 border-2 border-black">
            {STAGES.map((_, idx) => (
              <button
                key={idx}
                onClick={() => {
                  sounds.playClick();
                  setCurrentStep(idx);
                }}
                className={`w-7 h-7 font-mono text-xs font-black border transition-all cursor-pointer ${
                  currentStep === idx
                    ? 'bg-[#ffe500] text-black border-black shadow-sm font-black'
                    : idx < currentStep
                    ? 'bg-emerald-500 text-white border-black'
                    : 'bg-white text-neutral-600 border-neutral-300'
                }`}
              >
                {idx + 1}
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              sounds.playClick();
              onExit();
            }}
            className="p-2 bg-neutral-100 hover:bg-neutral-200 border-2 border-black cursor-pointer active:scale-95 text-black"
            title="Exit Academy"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Interactive Stage Container */}
      {currentStep < 4 ? (
        <div className="space-y-4">
          {/* Canvas Interactive Arena */}
          <div className="relative w-full aspect-[840/480] bg-black border-4 border-white shadow-brutal-white overflow-hidden select-none touch-none">
            <canvas
              ref={canvasRef}
              width={DESK_WIDTH}
              height={DESK_HEIGHT}
              className="w-full h-full cursor-crosshair select-none touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />

            {/* In-canvas Guidance Overlay Banner */}
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
              <div className="bg-black/90 text-white border-2 border-white/30 px-3 py-1.5 font-mono text-xs max-w-md shadow-md">
                <span className="text-[#ffe500] font-black uppercase mr-1">MISSION:</span>
                <span>{currentStageInfo.objective}</span>
              </div>

              {stepSuccess && (
                <div className="bg-emerald-500 text-black border-2 border-black font-broadcast font-black text-sm uppercase px-3 py-1 shadow-brutal-white flex items-center gap-1.5 animate-bounce">
                  <CheckCircle2 className="w-4 h-4 text-black stroke-[3]" />
                  <span>STAGE COMPLETE!</span>
                </div>
              )}
            </div>

            {/* Quick Reset Button on Arena */}
            <button
              onClick={() => {
                sounds.playClick();
                resetStage(currentStep);
              }}
              className="absolute bottom-3 right-3 bg-white/90 hover:bg-[#ffe500] text-black border-2 border-black px-3 py-1.5 font-broadcast font-black text-xs uppercase flex items-center gap-1.5 cursor-pointer shadow-brutal-black transition-all active:scale-95"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Lesson</span>
            </button>
          </div>

          {/* Interactive Controls & Coaching Strip */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            {/* Left Controls: Lesson Specific Switches */}
            <div className="md:col-span-8 p-4 bg-[#0e121b] border-4 border-white text-white shadow-brutal-yellow flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="bg-[#ffe500] text-black font-mono font-black text-[10px] px-2 py-0.5 border border-black uppercase">
                    COACHING DIRECTIVE
                  </span>
                  <span className="font-mono text-xs text-slate-400">
                    MECHANIC: {currentStageInfo.badge}
                  </span>
                </div>
                <p className="font-sans text-sm text-slate-200 leading-relaxed mb-4">
                  {currentStageInfo.tip}
                </p>

                {/* Lesson 2 Pen Switcher */}
                {currentStep === 1 && (
                  <div className="p-3 bg-black border-2 border-white/20 mb-2">
                    <div className="font-mono text-[10px] font-black text-[#ffe500] uppercase mb-2">
                      TEST MASS VARIANCE (EXPERIENCE VELOCITY VS FORCE):
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => {
                          sounds.playClick();
                          setActivePenId('bic_cristal');
                          resetStage(1, 'bic_cristal');
                        }}
                        className={`p-2 border-2 text-left font-mono transition-all cursor-pointer ${
                          activePenId === 'bic_cristal'
                            ? 'bg-[#ffe500] text-black border-black font-black shadow-sm'
                            : 'bg-neutral-900 text-white border-white/20 hover:border-white'
                        }`}
                      >
                        <div className="text-xs font-bold">Bic Cristal (5.8g)</div>
                        <div className="text-[10px] opacity-80">Light Featherweight · High speed</div>
                      </button>

                      <button
                        onClick={() => {
                          sounds.playClick();
                          setActivePenId('rotring_600');
                          resetStage(1, 'rotring_600');
                        }}
                        className={`p-2 border-2 text-left font-mono transition-all cursor-pointer ${
                          activePenId === 'rotring_600'
                            ? 'bg-[#ffe500] text-black border-black font-black shadow-sm'
                            : 'bg-neutral-900 text-white border-white/20 hover:border-white'
                        }`}
                      >
                        <div className="text-xs font-bold">Rotring 600 (23.5g)</div>
                        <div className="text-[10px] opacity-80">Brass Juggernaut · Crushing mass</div>
                      </button>
                    </div>
                  </div>
                )}

                {/* Lesson 4 Curve & Style Switcher */}
                {currentStep === 3 && (
                  <div className="p-3 bg-black border-2 border-white/20 mb-2 space-y-2">
                    <div className="flex items-center justify-between font-mono text-[10px] font-black text-[#ffe500] uppercase">
                      <span>CURVE BIAS CONTROL:</span>
                      <span>{curveModifier > 0 ? `+${curveModifier} RIGHT` : curveModifier < 0 ? `${curveModifier} LEFT` : 'STRAIGHT'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          sounds.playClick();
                          setCurveModifier(-0.6);
                        }}
                        className={`flex-1 py-1 px-2 border font-mono text-xs uppercase ${
                          curveModifier < -0.2 ? 'bg-[#ffe500] text-black font-bold' : 'bg-white/10 text-white'
                        }`}
                      >
                        Left Curve
                      </button>
                      <button
                        onClick={() => {
                          sounds.playClick();
                          setCurveModifier(0);
                        }}
                        className={`py-1 px-3 border font-mono text-xs uppercase ${
                          curveModifier === 0 ? 'bg-[#ffe500] text-black font-bold' : 'bg-white/10 text-white'
                        }`}
                      >
                        Flat
                      </button>
                      <button
                        onClick={() => {
                          sounds.playClick();
                          setCurveModifier(0.6);
                        }}
                        className={`flex-1 py-1 px-2 border font-mono text-xs uppercase ${
                          curveModifier > 0.2 ? 'bg-[#ffe500] text-black font-bold' : 'bg-white/10 text-white'
                        }`}
                      >
                        Right Curve
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Progress to Next Stage Button */}
              <div className="flex items-center justify-between pt-2 border-t border-white/10 mt-2">
                <span className="font-mono text-xs text-slate-400">
                  {stepSuccess ? 'Goal satisfied! Ready to advance.' : 'Complete the task above to proceed.'}
                </span>

                <button
                  onClick={() => {
                    sounds.playClick();
                    triggerHaptic('medium');
                    setCurrentStep((prev) => Math.min(4, prev + 1));
                  }}
                  disabled={!stepSuccess}
                  className={`flex items-center gap-2 px-5 py-2.5 font-broadcast font-black text-sm uppercase tracking-wider border-2 border-black transition-all cursor-pointer ${
                    stepSuccess
                      ? 'bg-[#ffe500] text-black shadow-brutal-white hover:-translate-y-0.5 active:scale-95'
                      : 'bg-neutral-800 text-neutral-500 border-neutral-700 cursor-not-allowed'
                  }`}
                >
                  <span>NEXT LESSON</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Right Card: Power Meter & Ergonomic Visualizer */}
            <div className="md:col-span-4 p-4 bg-white border-4 border-black shadow-brutal-black flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b-2 border-black pb-2 mb-3">
                  <span className="bg-black text-[#ffe500] font-mono font-black text-xs px-2 py-0.5 uppercase tracking-wider">
                    TACTILE METER
                  </span>
                  <span className="font-mono text-xs font-bold text-neutral-600">
                    HAPTIC FEEDBACK
                  </span>
                </div>

                <div className="space-y-3 font-mono">
                  <div className="flex justify-between text-xs font-bold text-neutral-800">
                    <span>AIM POWER BRACKET</span>
                    <span className="font-black text-black">
                      {Math.round(aimState.powerNormalized * 100)}%
                    </span>
                  </div>

                  {/* 4-Bracket Gauge */}
                  <div className="w-full bg-neutral-200 border-2 border-black h-5 overflow-hidden flex">
                    <div
                      className="bg-emerald-500 border-r border-black h-full transition-all"
                      style={{ width: `${Math.min(25, aimState.powerNormalized * 100)}%` }}
                    />
                    <div
                      className="bg-yellow-400 border-r border-black h-full transition-all"
                      style={{
                        width: `${Math.max(0, Math.min(25, aimState.powerNormalized * 100 - 25))}%`,
                      }}
                    />
                    <div
                      className="bg-orange-500 border-r border-black h-full transition-all"
                      style={{
                        width: `${Math.max(0, Math.min(25, aimState.powerNormalized * 100 - 50))}%`,
                      }}
                    />
                    <div
                      className="bg-red-600 h-full transition-all"
                      style={{ width: `${Math.max(0, aimState.powerNormalized * 100 - 75)}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-4 text-[9px] text-center font-bold text-neutral-600">
                    <span>25% TAP</span>
                    <span>50% GLIDE</span>
                    <span>75% DRIVE</span>
                    <span>100% IMPULSE</span>
                  </div>
                </div>

                <div className="p-3 bg-neutral-100 border border-black mt-4 font-mono text-[11px] text-neutral-700">
                  <span className="font-black text-black uppercase block mb-1">PRO ADVICE:</span>
                  Pull gently for short-range nudges. Overpowering past 80% without curve will send your pen airborne off the table!
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-neutral-300 flex items-center justify-between text-xs font-mono font-bold text-neutral-500">
                <span>{isMobile ? 'TOUCH FLICK ENABLED' : 'MOUSE DRAG ENABLED'}</span>
                <span>SUB-50MS ENGINE</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Stage 5: Economy, Unboxing & Academy Graduation */
        <div className="p-6 sm:p-8 bg-[#0e121b] border-4 border-white text-white shadow-brutal-yellow">
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center gap-2 bg-[#ffe500] text-black font-mono font-black text-xs px-3 py-1 border-2 border-black uppercase tracking-wider shadow-brutal-black">
              <Sparkles className="w-4 h-4 fill-black" />
              FINAL STAGE: PROGRESSION ECONOMY
            </div>

            <h2 className="font-broadcast text-4xl sm:text-5xl font-black italic uppercase leading-tight text-white">
              THE GEOMETRY BOX VAULT & GRADUATION
            </h2>

            <p className="text-slate-300 font-sans text-sm sm:text-base leading-relaxed">
              Every ranked win, tournament knockout, and sparring match earns Paperclips. Use your stash in the
              Geometry Vault to pop open wooden pencil boxes, tin math cases, and architect deluxe sets.
            </p>

            {/* Unboxing Pack Showcase */}
            <div className="p-6 bg-black border-3 border-white max-w-md mx-auto shadow-brutal-white">
              {!unboxingRevealed ? (
                <div className="space-y-4">
                  <div className="w-24 h-24 bg-blue-600 border-3 border-black mx-auto flex items-center justify-center text-4xl shadow-brutal-yellow animate-pulse">
                    📦
                  </div>
                  <div className="font-broadcast text-2xl font-black uppercase text-[#ffe500]">
                    PFA ACADEMY STARTER TIN
                  </div>
                  <p className="text-xs font-mono text-slate-400">
                    Contains +100 Graduation Paperclips and the exclusive Academy Gold Leaf custom skin!
                  </p>
                  <button
                    onClick={handleOpenAcademyTin}
                    className="w-full py-3.5 bg-[#ffe500] hover:bg-[#ecd400] text-black font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-white active:scale-95 transition-all"
                  >
                    POP OPEN ACADEMY TIN
                  </button>
                </div>
              ) : (
                <div className="space-y-4 animate-fadeIn">
                  <div className="w-20 h-20 bg-emerald-500 border-2 border-black mx-auto flex items-center justify-center text-3xl shadow-brutal-white">
                    🏆
                  </div>
                  <div className="font-broadcast text-3xl font-black italic uppercase text-emerald-400">
                    CONTRABAND UNLOCKED!
                  </div>
                  <div className="p-3 bg-white/10 border border-white/20 font-mono text-xs space-y-1">
                    <div className="text-[#ffe500] font-black">+100 BONUS PAPERCLIPS</div>
                    <div className="text-white font-bold">CUSTOM GOLD LEAF FINISH</div>
                    <div className="text-slate-400 text-[10px]">TUTORIAL GRADUATE DIPLOMA [EARNED]</div>
                  </div>

                  {!hasClaimedReward ? (
                    <button
                      onClick={handleGraduateAcademy}
                      className="w-full py-3.5 bg-emerald-400 hover:bg-emerald-300 text-black font-broadcast font-black text-lg uppercase tracking-wider border-2 border-black cursor-pointer shadow-brutal-white active:scale-95 transition-all"
                    >
                      CLAIM REWARD & ENTER THE ARENA
                    </button>
                  ) : (
                    <div className="p-3 bg-emerald-500/20 text-emerald-300 border border-emerald-500 font-mono text-xs font-bold uppercase">
                      ACADEMY CREDENTIALS SYNCED! REDIRECTING TO MATCH CENTER...
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
