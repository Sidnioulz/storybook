import { addons, types } from '@storybook/manager-api';
import { IconButton, Icons } from '@storybook/components';
import startCase from 'lodash/startCase.js';
import React, { Fragment } from 'react';

addons.setConfig({
  sidebar: {
    renderLabel: ({ name, type }) => (type === 'story' ? name : startCase(name)),
  },

  // FIXME/TODO
  toolbar: {
    showNav: () => {
      console.log('showNav: actual user config.');
      return false;
    },
    showTabs: ({ layout: { showToolbar, showTabs } }) => {
      console.log('showTabs: actual user config.');
      return false;
    },
    showToolbar: () => {
      console.log('showToolbar: actual user config.');
      return false;
    },
  },
});
