import _ from 'lodash';
import bluebird from 'bluebird';
import path from 'path';
import editorTabGroupActions from '../../containers/editor-tab-group/editor-tab-group.actions';
import fileService from '../../services/files';

const requesterId = 'file-viewer';

/**
 * @param {string} file
 * @returns {function}
 */
export function openViewedFile(file) {
  return function (dispatch, getState) {
    const state = getState();

    if (file.isDirectory) {
      return dispatch(setViewedPath(file.path));
    } else if (state.editorTabGroups.length) {
      // find first editorTabGroup, put it there
      const groupId = state.editorTabGroups[0].groupId;

      // NOTE: we could probably remove this and pass the file object directly (later when more immutable)
      return fileService.getFileStats(file.path)
        .then(stats => dispatch(editorTabGroupActions.add(groupId, file.path, stats)));
    }
  };
}

/**
 * @param {object} file
 * @returns {{type: string, file: object}}
 */
export function selectViewedFile(file) {
  return {type: 'SELECT_VIEWED_FILE', file};
}

/**
 * NOTE: Accepts ~ as a path start as well
 *
 * @param {string} filePath
 * @returns {function}
 */
export function getViewedFiles(filePath) {
  return function (dispatch, getState) {
    console.log('getViewedFiles', filePath);

    if (!filePath) {
      const state = getState();

      filePath = state.fileView.path;
    }

    const promise = bluebird.all([
      fileService.getFiles(filePath),
      bluebird.delay(200) // animation takes 200ms
    ]).then(result => result[0]);

    return promise
      .tap(result => dispatch(_.assign({type: 'SET_VIEWED_PATH', targetPath: filePath}, result)))
      .tap(() => fileService.startWatching(requesterId, path.join(filePath, '*')))
      .catch(error => console.error(error));
  };
}

function setViewedPath(filePath) {
  return function (dispatch, getState) {
    if (!filePath) {
      const state = getState();

      filePath = state.fileView.path;
    }

    console.log('setViewedPath, filePath', filePath);

    dispatch({type: 'SET_VIEWED_PATH', targetPath: filePath}, {path: filePath, files: []});

    const promise = bluebird.all([
      fileService.getFiles(filePath),
      bluebird.delay(200) // animation takes 200ms
    ]).then(result => result[0]);

    return promise
      .tap(result => dispatch(_.assign({type: 'SET_VIEWED_PATH', targetPath: filePath}, result)))
      .tap(() => fileService.startWatching(requesterId, path.join(filePath, '*')))
      .catch(error => console.error(error));
  };
}

/**
 * @returns {function}
 */
export function goToParentDirectory() {
  return function (dispatch, getState) {
    const fileView = getState().fileView;

    dispatch(setViewedPath(path.resolve(fileView.path, '..')));
  };
}

function expandFolder(itemPath) {
  return function (dispatch) {
    const file = _.last(itemPath),
      targetPath = file && file.path;

    return fileService.getFiles(targetPath)
      .tap(result => dispatch(_.assign({type: 'FILE_VIEWER_FOLDER_EXPANDED', itemPath, targetPath}, result)))
      .tap(() => fileService.addWatchingFiles(requesterId, path.join(targetPath, '*')))
      .catch(error => console.error(error));
  };
}

function contractFolder(itemPath) {
  return function (dispatch) {
    const file = _.last(itemPath),
      path = file && file.path;

    return dispatch({type: 'FILE_VIEWER_FOLDER_CONTRACTED', path, itemPath});
  };
}

export default {
  openViewedFile,
  selectViewedFile,
  setViewedPath,
  getViewedFiles,
  goToParentDirectory,
  expandFolder,
  contractFolder
};
