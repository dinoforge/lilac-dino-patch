'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {playableEpisodeNumber,episodeMetrics}=require('../src/integrated-search.js');

test('episode numbering parses Korean, Japanese and English without guessing catalog episodes',()=>{
  assert.equal(playableEpisodeNumber({name:'제 12화'}),12);
  assert.equal(playableEpisodeNumber({name:'第13話'}),13);
  assert.equal(playableEpisodeNumber({name:'Episode 14'}),14);
  assert.equal(playableEpisodeNumber({name:'EP. 15'}),15);
  assert.equal(playableEpisodeNumber({number:16,name:'16화'}),16);
  assert.equal(playableEpisodeNumber({special:true,number:16}),null);
  assert.equal(playableEpisodeNumber({playable:false,number:17}),null);
  assert.equal(playableEpisodeNumber({name:'2026년 방영 예정'}),null);
});

test('episode comparison deduplicates dub/sub and ignores specials and unplayable entries',()=>{
  const input={episodes:[
    {number:1},{number:1,dub:true},{name:'Episode 2'},
    {name:'제 3화'},{name:'第4話'},
    {number:200,special:true},{number:999,playable:false}
  ]};
  assert.deepEqual(episodeMetrics(input),{count:4,latest:4});
  assert.deepEqual(episodeMetrics({episodes:[]}),{count:0,latest:0});
  assert.equal(episodeMetrics({unavailable:true,episodes:input.episodes}),null);
  assert.equal(episodeMetrics({data:{episodes:input.episodes}}),null);
});
