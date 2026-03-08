/*---------------------------------------------------------------------------*\
  =========                 |
  \\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\    /   O peration     |
    \\  /    A nd           | www.openfoam.com
     \\/     M anipulation  |
-------------------------------------------------------------------------------
License
    This file is part of OpenFOAM.

    OpenFOAM is free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    OpenFOAM is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
    FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
    for more details.

    You should have received a copy of the GNU General Public License
    along with OpenFOAM.  If not, see <http://www.gnu.org/licenses/>.

Class
    Foam::functionObjects::registryDump

Description
    Dumps the contents of the objectRegistry at each write time.

    For each registered object, outputs:
    - name
    - type (class name)
    - whether it is set to AUTO_WRITE

    Output is written to postProcessing/registryDump/<time>/registry.

    Usage in system/controlDict:
    \verbatim
    functions
    {
        registryDump1
        {
            type    registryDump;
        }
    }
    \endverbatim

SourceFiles
    registryDump.C

\*---------------------------------------------------------------------------*/

#ifndef functionObjects_registryDump_H
#define functionObjects_registryDump_H

#include "fvMeshFunctionObject.H"

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

namespace Foam
{
namespace functionObjects
{

/*---------------------------------------------------------------------------*\
                       Class registryDump Declaration
\*---------------------------------------------------------------------------*/

class registryDump
:
    public fvMeshFunctionObject
{
    // Private Member Functions

        //- No copy construct
        registryDump(const registryDump&) = delete;

        //- No copy assignment
        void operator=(const registryDump&) = delete;


public:

    //- Runtime type information
    TypeName("registryDump");


    // Constructors

        //- Construct from Time and dictionary
        registryDump
        (
            const word& name,
            const Time& runTime,
            const dictionary& dict
        );


    //- Destructor
    virtual ~registryDump() = default;


    // Member Functions

        virtual bool read(const dictionary& dict);
        virtual bool execute();
        virtual bool write();
};


// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

} // End namespace functionObjects
} // End namespace Foam

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

#endif

// ************************************************************************* //
