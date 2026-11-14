/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Megaphone, 
  Pin, 
  Calendar, 
  Sparkles, 
  PlusCircle, 
  Trash2, 
  CheckCircle, 
  ArrowRight, 
  BookOpen, 
  Wrench, 
  Trophy, 
  X,
  Filter
} from 'lucide-react';
import { collection, query, orderBy, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';
import { Announcement, GameView } from '../types/game';
import { sounds } from '../utils/audio';

interface NewsViewProps {
  isAdminUser?: boolean;
  userEmail?: string;
  onNavigate: (view: GameView) => void;
}

const FALLBACK_ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'ann-1',
    title: 'Pen Fight 27 Academy & Boot Camp Interactive Training Live!',
    content: `Welcome to the official Pen Fight 27 Training Academy! Whether you are a rookie flicking your first plastic Bic Cristal or a veteran handling a heavyweight Rotring 600 mechanical pencil, our new interactive 5-stage tutorial walks you through real-world mass ratios (5.8g vs 23.5g), edge-braking power control, gyro spin curves, and the Geometry Vault reward system.\n\nGraduating from the Academy grants an immediate +100 Paperclips and the exclusive Golden Leaf skin!`,
    category: 'FEATURE',
    pinned: true,
    authorName: 'Sam (Lead Director)',
    authorUid: 'admin-lead',
    createdAt: new Date(Date.now() - 3600000 * 2),
  },
  {
    id: 'ann-2',
    title: 'Ranked Fair Play: AI Bots Permanently Isolated to Bot Lab',
    content: `By popular player request, we have completely overhauled competitive matchmaking. AI bots are strictly confined to the offline 'Bot Lab' sandbox where you can tune CPU difficulty from Dummy to Cyborg Apex.\n\nThe global leaderboard and Ranked match queue are now strictly 100% human-verified players with crossplay options enabled!`,
    category: 'PATCH_NOTES',
    pinned: true,
    authorName: 'Sam (Lead Director)',
    authorUid: 'admin-lead',
    createdAt: new Date(Date.now() - 3600000 * 12),
  },
  {
    id: 'ann-3',
    title: 'Classroom Physics Engine 2.7: Inelastic Momentum & Spin Torque',
    content: `Physics overhaul highlights:\n• Momentum formula re-tuned to direct impulse over mass (v = J / mass).\n• Edge braking: table rim friction now offers a split-second drag recovery when sliding near the abyss.\n• Flick Styles: unlock Spin Wizard, Precision Tap, and Heavy Hammer to tailor your classroom meta.`,
    category: 'PATCH_NOTES',
    pinned: false,
    authorName: 'Sam (Lead Director)',
    authorUid: 'admin-lead',
    createdAt: new Date(Date.now() - 3600000 * 24),
  },
  {
    id: 'ann-4',
    title: 'Mobile Ergonomics & Responsive Touch-Slingshot Controls',
    content: `Pen Fight 27 is now fully tuned for one-handed mobile play. Enjoy tactile visual slingshot arcs, quick-action navigation docks, and crossplay filtering (choose Same Platform Only or Crossplay Enabled in your match settings).`,
    category: 'FEATURE',
    pinned: false,
    authorName: 'Sam (Lead Director)',
    authorUid: 'admin-lead',
    createdAt: new Date(Date.now() - 3600000 * 48),
  },
  {
    id: 'ann-5',
    title: 'Desk Grand Prix Season 1 Registration Open',
    content: `Compete for the legendary Golden Sharpener Trophy and a prize pool of 5,000 Paperclips! Double-elimination format across 3 iconic classrooms: Oak Desk Arena, Biology Lab Slate, and Cafeteria Stainless Steel.`,
    category: 'TOURNAMENT',
    pinned: false,
    authorName: 'Sam (Lead Director)',
    authorUid: 'admin-lead',
    createdAt: new Date(Date.now() - 3600000 * 72),
  }
];

export const NewsView: React.FC<NewsViewProps> = ({
  isAdminUser = false,
  userEmail,
  onNavigate,
}) => {
  const [announcements, setAnnouncements] = useState<Announcement[]>(FALLBACK_ANNOUNCEMENTS);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [isAuthorModalOpen, setIsAuthorModalOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form states
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<'PATCH_NOTES' | 'TOURNAMENT' | 'FEATURE' | 'ANNOUNCEMENT'>('FEATURE');
  const [newContent, setNewContent] = useState('');
  const [newPinned, setNewPinned] = useState(false);

  useEffect(() => {
    try {
      const q = query(
        collection(db, 'announcements'),
        orderBy('createdAt', 'desc')
      );

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          if (!snapshot.empty) {
            const fetched = snapshot.docs.map((docSnap) => {
              const data = docSnap.data();
              return {
                id: docSnap.id,
                title: data.title || 'Untitled Bulletin',
                content: data.content || '',
                category: data.category || 'ANNOUNCEMENT',
                pinned: !!data.pinned,
                authorName: data.authorName || 'Desk Official',
                authorUid: data.authorUid || '',
                createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
              } as Announcement;
            });

            // Sort pinned first
            fetched.sort((a, b) => {
              if (a.pinned && !b.pinned) return -1;
              if (!a.pinned && b.pinned) return 1;
              return 0;
            });

            setAnnouncements(fetched);
          } else {
            // Keep fallbacks if no documents yet
            setAnnouncements(FALLBACK_ANNOUNCEMENTS);
          }
        },
        (error) => {
          console.warn('Firestore announcements listener notice (using fallbacks):', error);
          setAnnouncements(FALLBACK_ANNOUNCEMENTS);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      console.warn('Using fallback news feed due to offline/permission state:', err);
      setAnnouncements(FALLBACK_ANNOUNCEMENTS);
    }
  }, []);

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      setErrorMsg('Please enter both a title and article body content.');
      return;
    }

    setIsPublishing(true);
    setErrorMsg(null);

    try {
      await addDoc(collection(db, 'announcements'), {
        title: newTitle.trim(),
        content: newContent.trim(),
        category: newCategory,
        pinned: newPinned,
        authorName: userEmail ? userEmail.split('@')[0] : 'Sam (Admin)',
        authorUid: userEmail || 'admin',
        createdAt: serverTimestamp(),
      });

      sounds.win();
      setPublishSuccess(true);
      setNewTitle('');
      setNewContent('');
      setNewPinned(false);
      setTimeout(() => {
        setPublishSuccess(false);
        setIsAuthorModalOpen(false);
      }, 1200);
    } catch (err: any) {
      console.error('Failed to post announcement:', err);
      setErrorMsg(err.message || 'Failed to publish to Firestore.');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this announcement?')) return;
    try {
      await deleteDoc(doc(db, 'announcements', id));
      sounds.flick();
      setAnnouncements(prev => prev.filter(a => a.id !== id));
    } catch (err: any) {
      console.error('Failed to delete announcement:', err);
      // If it's a fallback item, remove from local state
      setAnnouncements(prev => prev.filter(a => a.id !== id));
    }
  };

  const filteredAnnouncements = announcements.filter(item => {
    if (selectedCategory === 'ALL') return true;
    return item.category === selectedCategory;
  });

  const getCategoryBadge = (cat: string) => {
    switch (cat) {
      case 'FEATURE':
        return { label: 'FEATURE DROP', bg: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', icon: Sparkles };
      case 'PATCH_NOTES':
        return { label: 'PATCH NOTES', bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40', icon: Wrench };
      case 'TOURNAMENT':
        return { label: 'TOURNAMENT', bg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40', icon: Trophy };
      default:
        return { label: 'COMMUNITY', bg: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40', icon: Megaphone };
    }
  };

  const formatDate = (date: any) => {
    if (!date) return 'Recently';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return 'Recently';
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div className="min-h-[calc(100vh-64px)] bg-[#07090e] text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* Header Hero */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#10141f] via-[#0d1018] to-[#0a0d14] border-2 border-slate-800 p-6 md:p-8 shadow-2xl">
          <div className="absolute top-0 right-0 w-96 h-96 bg-[#ffe500]/5 rounded-full blur-3xl pointer-events-none" />
          
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#ffe500]/10 border border-[#ffe500]/30 text-[#ffe500] text-xs font-black tracking-widest uppercase mb-3">
                <Megaphone className="w-3.5 h-3.5" />
                OFFICIAL BULLETIN & DEV NOTES
              </div>
              <h1 className="text-3xl md:text-5xl font-black italic tracking-tight text-white uppercase flex items-center gap-3">
                PEN FIGHT <span className="text-[#ffe500]">NEWS</span>
              </h1>
              <p className="text-slate-400 text-sm md:text-base mt-2 max-w-xl">
                Stay updated with the latest classroom balance patches, physics tune-ups, competitive tournaments, and new stationery drops.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => {
                  sounds.flick();
                  onNavigate('TUTORIAL');
                }}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition hover:scale-105 active:scale-95 shadow-md"
              >
                <BookOpen className="w-4 h-4 text-[#ffe500]" />
                Boot Camp Academy
              </button>

              {isAdminUser && (
                <button
                  onClick={() => {
                    sounds.flick();
                    setIsAuthorModalOpen(true);
                  }}
                  className="px-5 py-2.5 rounded-xl bg-[#ffe500] hover:bg-[#fff04d] text-black font-black text-xs uppercase tracking-wider flex items-center gap-2 transition hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(255,229,0,0.35)]"
                >
                  <PlusCircle className="w-4 h-4 text-black" />
                  Publish Announcement
                </button>
              )}
            </div>
          </div>

          {/* Quick Academy Launch Banner inside Hero */}
          <div className="mt-6 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-black/30 -mx-6 md:-mx-8 -mb-6 md:-mb-8 p-4 md:px-8">
            <div className="flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-xs font-bold text-slate-300">
                New to the game? Take the 5-minute interactive Academy and claim <strong className="text-[#ffe500]">+100 Paperclips</strong> &amp; <strong className="text-amber-300">Gold Leaf Skin</strong>.
              </span>
            </div>
            <button
              onClick={() => {
                sounds.flick();
                onNavigate('TUTORIAL');
              }}
              className="text-xs font-black text-[#ffe500] hover:underline flex items-center gap-1.5 uppercase tracking-wider shrink-0"
            >
              Start Academy <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Filter Navigation */}
        <div className="flex items-center justify-between gap-4 flex-wrap pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-none">
            <span className="text-xs font-black text-slate-500 uppercase tracking-widest mr-1 flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" /> Filter:
            </span>
            {[
              { id: 'ALL', label: 'All News' },
              { id: 'PATCH_NOTES', label: 'Patch Notes' },
              { id: 'FEATURE', label: 'Features' },
              { id: 'TOURNAMENT', label: 'Tournaments' },
              { id: 'ANNOUNCEMENT', label: 'Community' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => {
                  sounds.flick();
                  setSelectedCategory(tab.id);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition ${
                  selectedCategory === tab.id
                    ? 'bg-[#ffe500] text-black shadow-md'
                    : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="text-xs font-mono text-slate-500">
            Showing {filteredAnnouncements.length} bulletin{filteredAnnouncements.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Feed List */}
        <div className="space-y-4">
          {filteredAnnouncements.map((post) => {
            const badge = getCategoryBadge(post.category);
            const BadgeIcon = badge.icon;

            return (
              <article
                key={post.id}
                className={`relative rounded-2xl p-6 transition-all border ${
                  post.pinned
                    ? 'bg-gradient-to-r from-[#121824] via-[#0d121c] to-[#0b0e17] border-amber-500/40 shadow-[0_0_25px_rgba(245,158,11,0.08)]'
                    : 'bg-[#0c0f17] border-slate-800/80 hover:border-slate-700 hover:bg-[#0f131d]'
                }`}
              >
                {/* Pinned Marker */}
                {post.pinned && (
                  <div className="absolute top-0 right-8 -translate-y-1/2 flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-black tracking-widest uppercase shadow-md">
                    <Pin className="w-3 h-3 fill-current" />
                    PINNED BULLETIN
                  </div>
                )}

                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-2.5 flex-1">
                    
                    {/* Meta row */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider border ${badge.bg}`}>
                        <BadgeIcon className="w-3 h-3" />
                        {badge.label}
                      </span>

                      <span className="flex items-center gap-1.5 text-xs text-slate-400 font-mono">
                        <Calendar className="w-3.5 h-3.5 text-slate-500" />
                        {formatDate(post.createdAt)}
                      </span>

                      <span className="text-xs text-slate-500 font-mono">
                        • by <strong className="text-slate-300 font-semibold">{post.authorName}</strong>
                      </span>
                    </div>

                    {/* Title */}
                    <h2 className="text-xl md:text-2xl font-black text-white tracking-tight">
                      {post.title}
                    </h2>

                    {/* Content Body */}
                    <div className="text-slate-300 text-sm md:text-base leading-relaxed whitespace-pre-line font-normal max-w-4xl pt-1">
                      {post.content}
                    </div>

                    {/* Interactive inline CTA if Academy related */}
                    {post.title.toLowerCase().includes('academy') && (
                      <div className="pt-2">
                        <button
                          onClick={() => {
                            sounds.flick();
                            onNavigate('TUTORIAL');
                          }}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-[#ffe500] to-amber-400 text-black font-black text-xs uppercase tracking-wider hover:opacity-95 shadow-md active:scale-95 transition"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          Launch Academy Tutorial
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Admin Delete Action */}
                  {isAdminUser && (
                    <div className="flex items-center md:flex-col gap-2 shrink-0 self-end md:self-start">
                      <button
                        onClick={(e) => handleDelete(post.id, e)}
                        title="Delete Announcement"
                        className="p-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition text-xs flex items-center gap-1"
                      >
                        <Trash2 className="w-4 h-4" />
                        <span className="md:hidden">Delete</span>
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>

      </div>

      {/* Admin Author Announcement Modal */}
      {isAuthorModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-2xl bg-[#0e131f] border-2 border-[#ffe500] rounded-2xl p-6 md:p-8 shadow-[0_0_50px_rgba(255,229,0,0.25)] space-y-6 max-h-[90vh] overflow-y-auto">
            
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-[#ffe500]/10 text-[#ffe500]">
                  <Megaphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-xl font-black text-white uppercase italic">
                    Publish Official Announcement
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">
                    Posting as Admin ({userEmail || 'samwdoesthings@gmail.com'})
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsAuthorModalOpen(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {publishSuccess && (
              <div className="p-4 rounded-xl bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 text-sm font-bold flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-emerald-400" />
                Bulletin published successfully to all active players!
              </div>
            )}

            {errorMsg && (
              <div className="p-4 rounded-xl bg-red-500/20 border border-red-500/50 text-red-300 text-xs font-mono">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handlePublish} className="space-y-4">
              
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-300 mb-2">
                  Headline / Title
                </label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., Pen Fight 27 Classroom Cup & Balance Hotfix"
                  className="w-full px-4 py-3 rounded-xl bg-[#090b10] border border-slate-700 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-[#ffe500] transition"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black uppercase tracking-wider text-slate-300 mb-2">
                    Category
                  </label>
                  <select
                    value={newCategory}
                    onChange={(e: any) => setNewCategory(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-[#090b10] border border-slate-700 text-white text-sm font-medium focus:outline-none focus:border-[#ffe500] transition"
                  >
                    <option value="FEATURE">Feature Release</option>
                    <option value="PATCH_NOTES">Patch Notes / Balance</option>
                    <option value="TOURNAMENT">Tournament / Event</option>
                    <option value="ANNOUNCEMENT">General Announcement</option>
                  </select>
                </div>

                <div className="flex items-center gap-3 pt-6 sm:pt-7">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={newPinned}
                      onChange={(e) => setNewPinned(e.target.checked)}
                      className="w-4 h-4 rounded text-[#ffe500] bg-slate-900 border-slate-700 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                      <Pin className="w-3.5 h-3.5 text-amber-400" />
                      Pin to Top of Feed
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-300 mb-2">
                  Content Body (Markdown &amp; Line breaks supported)
                </label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Write the full update notes here..."
                  rows={6}
                  className="w-full px-4 py-3 rounded-xl bg-[#090b10] border border-slate-700 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-[#ffe500] transition resize-y font-sans"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAuthorModalOpen(false)}
                  className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs uppercase tracking-wider transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPublishing}
                  className="px-6 py-2.5 rounded-xl bg-[#ffe500] hover:bg-[#fff04d] text-black font-black text-xs uppercase tracking-wider transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:scale-100 flex items-center gap-2 shadow-[0_0_20px_rgba(255,229,0,0.3)]"
                >
                  {isPublishing ? 'Publishing...' : 'Publish to Feed'}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

    </div>
  );
};
