export function lastPageOffset(count, pageSize) {
  return count === 0 ? 0 : Math.floor((count - 1) / pageSize) * pageSize;
}

export function pageOffset(action, offset, pageSize, count) {
  const last = lastPageOffset(count, pageSize);
  switch (action) {
    case 'first': return 0;
    case 'prev': return Math.max(0, offset - pageSize);
    case 'next': return Math.min(last, offset + pageSize);
    case 'last': return last;
    default: throw new Error('Unknown pagination action: ' + action);
  }
}
