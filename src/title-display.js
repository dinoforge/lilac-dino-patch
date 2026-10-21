(function attachTitleDisplay(root) {
  const clean = value => String(value || '').trim();
  const sameTitle = (left, right) => clean(left).toLocaleLowerCase() === clean(right).toLocaleLowerCase();
  const hasKorean = value => /[가-힣]/.test(clean(value));

  function providerKoreanTitle(anime) {
    return [anime?.title_korean, anime?.title_ko, anime?.korean_title, anime?.titleKo, anime?.title]
      .map(clean).find(hasKorean) || '';
  }

  function primaryTitle(anime, translatedKorean = '') {
    if (!anime) return '제목 없음';
    return [providerKoreanTitle(anime), translatedKorean].map(clean).find(hasKorean)
      || [anime.title_japanese, anime.title_native, anime.title_original, anime.title, anime.title_english].map(clean).find(Boolean)
      || '제목 없음';
  }

  function originalTitle(anime, primary = primaryTitle(anime)) {
    if (!anime) return '';
    const native = [anime.title_japanese, anime.title_native, anime.title_original].map(clean).find(Boolean);
    if (native) return sameTitle(native, primary) ? '' : native;
    return [anime.title, anime.title_english].map(clean).find(value => value && !sameTitle(value, primary)) || '';
  }

  const api = Object.freeze({ hasKorean, providerKoreanTitle, primaryTitle, originalTitle });
  root.LilacTitleDisplay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
