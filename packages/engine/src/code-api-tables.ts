// tables: rows plus plain-word columns, kept on the machine so every chat, routine and watcher
// shares them. fill() runs your function per row (a page read, a site API call, a crawl) and
// reports which rows changed, so a routine check that refills a column is a watcher on it.
// Evaluated in the code sandbox with the other APIs.
export const browserTablesApi = `
function __csvCell(value) {
  var text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  var quote = text.includes(',') || text.includes('"') || text.includes(String.fromCharCode(10));
  return quote ? '"' + text.replace(/"/g, '""') + '"' : text;
}
async function __tableFill(handle, column, fn, options) {
  if (typeof fn !== 'function') throw Error('INVALID_ARGUMENT: table.fill(column, async (row) => value)');
  var all = await handle.rows({limit: 20000, ...(options.where ? {where: options.where} : {})});
  var empty = (row) => row[column] === undefined || row[column] === null || row[column] === '';
  var targets = options.all ? all : all.filter(empty);
  var queue = targets.slice(), updates = [], failed = [];
  var worker = async () => {
    while (queue.length) {
      var row = queue.shift();
      try {
        var value = await fn(row);
        if (value !== undefined) updates.push({[handle.key]: row[handle.key], [column]: value});
      } catch (error) { failed.push({key: row[handle.key], error: String(error && error.message || error)}); }
      bu.progress(updates.length + failed.length, targets.length, 'filling ' + column);
    }
  };
  await Promise.all(Array.from({length: Math.max(1, Math.min(Number(options.concurrency) || 4, 16))}, worker));
  var saved = updates.length ? await __call({table: 'upsert', name: handle.name, rows: updates}) : {changed: []};
  return {filled: updates.length, changed: saved.changed, failed};
}
function __tableHandle(info) {
  var name = info.name;
  var handle = {
    name, key: info.key, columns: info.columns,
    rows: (options = {}) => __call({table: 'rows', name, ...options}),
    add: (rows) => __call({table: 'upsert', name, rows: Array.isArray(rows) ? rows : [rows]}),
    update: (key, values) => __call({table: 'upsert', name, rows: [{...values, [info.key]: key}]}),
    remove: (keys) => __call({table: 'remove', name, keys: [].concat(keys)}),
    fill: (column, fn, options = {}) => __tableFill(handle, column, fn, options),
    export: async (file) => {
      var all = await handle.rows({limit: 20000});
      var columns = Object.keys(info.columns);
      var lines = [columns.map(__csvCell).join(',')].concat(all.map((row) => columns.map((column) => __csvCell(row[column])).join(',')));
      return artifact(file || 'tables/' + name + '.csv', lines.join(String.fromCharCode(10)));
    },
  };
  return Object.freeze(handle);
}
var tables = Object.freeze({
  list: () => __call({table: 'list'}),
  open: async (name, options = {}) => __tableHandle(await __call({table: 'open', name: String(name), ...options})),
  drop: (name) => __call({table: 'drop', name: String(name)}),
});
`;
