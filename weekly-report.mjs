// Normalize versioned research records without assuming a particular week's schema.
export function weeklyReport(research) {
  const c=research.coverage || {}, start=c.from || c.startInclusive, end=c.toExclusive || c.endExclusive;
  const views=research.traderViews?.items || research.traderViews?.added || [];
  if(!start || !end || !Array.isArray(research.projects) || !Array.isArray(views)) throw new Error('Invalid weekly research record');
  const period=`${start.slice(5,10).replace('-', '/')}–${new Date(Date.parse(end.slice(0,10)+'T12:00:00Z')-86400000).toISOString().slice(5,10).replace('-', '/')} KST`;
  const updated=research.projects.filter(p=>p.note);
  const short=s=>s.length>100?s.slice(0,99)+'…':s;
  const highlights=(research.telegramHighlights || updated.slice(0,3).map(p=>`${p.name}: ${p.note}`)).slice(0,3).map(s=>'• '+short(s));
  const text=[`OPSHNZ · ${period}`,`${research.projects.length}개 검토 · 소식 ${updated.length}건 · 시장 관점 ${views.length}건`,'',...highlights,'','https://opshnz.com/#/trader-views'].join('\n');
  return {period,text};
}
