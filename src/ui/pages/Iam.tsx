import React from 'react';
import './iam/iam.css';
import { Dashboard } from './iam/Dashboard';
import { Users } from './iam/Users';
import { CreateUser } from './iam/CreateUser';
import { UserDetail } from './iam/UserDetail';
import { Groups, CreateGroup, GroupDetail } from './iam/Groups';
import { Roles, CreateRole, RoleDetail } from './iam/Roles';
import { Policies, CreatePolicy, PolicyDetail } from './iam/Policies';

const seg = (path: string, i: number) => decodeURIComponent(path.split('/')[i] ?? '');

export function IamPages({ path }: { path: string }) {
  if (path.startsWith('/iam/users/create')) return <CreateUser />;
  if (path.startsWith('/iam/users/')) return <UserDetail key={seg(path, 3)} name={seg(path, 3)} />;
  if (path.startsWith('/iam/users')) return <Users />;
  if (path.startsWith('/iam/groups/create')) return <CreateGroup />;
  if (path.startsWith('/iam/groups/')) return <GroupDetail key={seg(path, 3)} name={seg(path, 3)} />;
  if (path.startsWith('/iam/groups')) return <Groups />;
  if (path.startsWith('/iam/roles/create')) return <CreateRole />;
  if (path.startsWith('/iam/roles/')) return <RoleDetail key={seg(path, 3)} name={seg(path, 3)} />;
  if (path.startsWith('/iam/roles')) return <Roles />;
  if (path.startsWith('/iam/policies/create')) return <CreatePolicy />;
  if (path.startsWith('/iam/policies/')) return <PolicyDetail key={path} arn={decodeURIComponent(path.slice('/iam/policies/'.length))} />;
  if (path.startsWith('/iam/policies')) return <Policies />;
  return <Dashboard />;
}
