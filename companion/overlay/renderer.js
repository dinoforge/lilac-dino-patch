'use strict';
const days=['월','화','수','목','금','토','일'];
const labels={playable:'재생 가능',provided:'제공 확인',missing:'미제공',checking:'확인 중',failed:'확인 실패'};
const $=id=>document.getElementById(id);
let data=null;
let selected=0;
let following=false;

function node(tag,className,text) {
  const el=document.createElement(tag);
  if(className) el.className=className;
  if(text!==undefined) el.textContent=String(text);
  return el;
}
function render() {
  if(!data) return;
  const title=data.currentQuarter?.label||data.year+'년 '+data.quarter+'분기';
  $('quarter').textContent=title+' · 이번 주';
  const tabs=$('days');tabs.replaceChildren();
  days.forEach((label,index)=>{
    const button=node('button','chip',label);
    button.type='button';button.role='tab';
    button.setAttribute('aria-selected',String(index===selected));
    button.addEventListener('click',()=>{selected=index;render()});
    tabs.append(button);
  });
  const work=data.days?.[selected]?.[0];
  const card=$('card'), providers=$('providers');
  card.replaceChildren();providers.replaceChildren();
  if(!work){card.append(node('p','work-meta','선택한 요일에 예시 작품이 없습니다.'));return}
  card.append(node('div','poster','예시'));
  const detail=node('div');
  detail.append(node('h3','work-title',work.title || '이름 없는 작품'));
  detail.append(node('p','work-meta',(work.airingTime||'--:--')+' · '+String(work.weekdayEpisodeNumber||'?')+'화 · 가상 작품'));
  card.append(detail);
  for(const source of work.sources||[]){
    const row=node('div','provider');
    row.append(node('span','',source.name||source.provider));
    const state=source.status?.state||'failed';
    const status=node('span','status',labels[state]||'확인 불가');
    status.dataset.state=state;
    row.append(status);providers.append(row);
  }
}
function setFollowing(value,message) {
  following=Boolean(value);
  $('follow').disabled=following;
  $('stop').disabled=!following;
  if(message) $('connection-status').textContent=message;
}
$('follow').addEventListener('click',async()=>{
  try {
    const result=await window.lilacOverlay.start();
    setFollowing(result.following,result.reason||'LilacAnime 창을 찾는 중…');
  } catch(e){setFollowing(false,'시작 실패: '+String(e?.message||e))}
});
$('stop').addEventListener('click',async()=>{
  try {await window.lilacOverlay.stop();setFollowing(false,'창 따라가기가 해제됐습니다.')}
  catch(e){setFollowing(false,'해제 실패: '+String(e?.message||e))}
});
$('theme').addEventListener('click',()=>{
  const light=document.body.classList.toggle('light');
  $('theme').textContent=light?'다크':'라이트';
});
window.lilacOverlay.onStatus(status=>{
  setFollowing(status.following,status.message||'창 상태를 확인할 수 없습니다.');
});
window.lilacOverlay.calendar().then(state=>{
  data=state;selected=Number(state.todayIndex)||0;render();
}).catch(e=>{$('quarter').textContent='예시 데이터 로드 실패';$('connection-status').textContent=String(e?.message||e)});
