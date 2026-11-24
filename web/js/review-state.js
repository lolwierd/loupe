export const currentReviewEvent = (pr) => pr?.headRefOid && pr.viewerReview?.head === pr.headRefOid ? pr.viewerReview.event : null;

export const hasPendingReview = (github) => !!(github?.pending?.comments?.length || github?.pending?.body?.trim());

export function reviewEventBlock(pr, event) {
  if (event === 'COMMENT') return '';
  if (pr?.viewerIsAuthor) return 'GitHub only allows comments on your own pull request';
  if (event !== currentReviewEvent(pr)) return '';
  return event === 'APPROVE' ? 'You already approved this commit' : 'You already requested changes on this commit';
}
