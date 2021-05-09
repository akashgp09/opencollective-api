import { GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import models from '../../../models';
import { editPublicMessage } from '../../common/members';
import { Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { MemberInvitationInput } from '../input/MemberInvitationInput';
import { Member } from '../object/Member';
import { MemberInvitation } from '../object/MemberInvitation';

const memberMutations = {
  editPublicMessage: {
    type: new GraphQLNonNull(Member),
    description: 'Edit the public message for the given Member of a Collective',
    args: {
      fromAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the donating Collective',
      },
      toAccount: {
        type: GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to an account for the receiving Collective',
      },
      message: {
        type: GraphQLString,
        description: 'New public message',
      },
    },
    async resolve(_, args, req) {
      let { fromAccount, toAccount } = args;
      const { message } = args;

      toAccount = await fetchAccountWithReference(toAccount);
      fromAccount = await fetchAccountWithReference(fromAccount);

      return await editPublicMessage(
        _,
        {
          fromAccount,
          toAccount,
          message,
        },
        req,
      );
    },
  },
  inviteMember: {
    type: new GraphQLNonNull(MemberInvitation),
    description: 'Invite a new member to the Collective',
    args: {
      memberInvitation: {
        type: GraphQLNonNull(MemberInvitationInput),
        description: 'Reference to an account for the invitee',
      },
    },
    async resolve(_, args, req) {
      let { memberAccount, account } = args.memberInvitation;

      memberAccount = await fetchAccountWithReference(memberAccount);
      account = await fetchAccountWithReference(account);

      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Unauthorized('Only admins can send an invitation.');
      }

      const memberParams = {
        ...pick(args.memberInvitation, ['role', 'description', 'since']),
        MemberCollectiveId: memberAccount.id,
        CreatedByUserId: req.remoteUser.id,
      };

      // Invite member
      await models.MemberInvitation.invite(account, memberParams);

      const invitation = await models.MemberInvitation.findOne({
        where: {
          CollectiveId: account.id,
          MemberCollectiveId: memberParams.MemberCollectiveId,
        },
      });

      return invitation;
    },
  },
};

export default memberMutations;
